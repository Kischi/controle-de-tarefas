/**
 * A página consulta o Claude Code desta máquina, numa sessão separada, na pasta do projeto.
 *
 * Duas tarefas, só de leitura: revisar o prompt de uma tarefa nova e conferir no código o que já foi feito.
 *
 * O que protege: só Read, Grep e Glob, sem shell nem rede; o que o git ignora e os segredos comuns negados;
 * nada de MCP, skills ou sessão guardada. O CLAUDE.md não é carregado e o Claude busca nele só o trecho da
 * área: um CLAUDE.md grande pesaria em toda chamada, até para responder "ok". Sem ele e sem a memória, a base
 * de uma chamada fica em uns 8 mil tokens.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MINUTOS_MAXIMOS = 30;
const CARACTERES_POR_TAREFA = 900;

// ---- o programa e a conta

const versaoDe = (caminho) => (/(\d+)\.(\d+)\.(\d+)/.exec(caminho) ?? [0, 0, 0, 0]).slice(1).map(Number);

function compararVersao(a, b) {
  const [x, y] = [versaoDe(a), versaoDe(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

const subpastas = (pasta) => {
  try { return fs.readdirSync(pasta).map((n) => path.join(pasta, n)); } catch { return []; }
};

const executavel = (caminho) => {
  try { fs.accessSync(caminho, fs.constants.X_OK); return fs.statSync(caminho).isFile(); } catch { return false; }
};

/** Primeiro o que está no PATH; depois o da extensão do editor e o do app, cujo caminho muda a cada versão. */
export function acharPrograma(base = process.env) {
  if (base.TAREFAS_CLAUDE_BIN) return base.TAREFAS_CLAUDE_BIN;
  const casa = os.homedir();
  const noPath = (base.PATH ?? '').split(path.delimiter).filter(Boolean).map((p) => path.join(p, 'claude'));
  const instalados = [
    path.join(casa, '.local', 'bin', 'claude'),
    path.join(casa, '.claude', 'local', 'claude'),
  ];
  const extensoes = ['.vscode', '.vscode-insiders', '.vscode-server', '.cursor']
    .flatMap((editor) => subpastas(path.join(casa, editor, 'extensions')))
    .filter((p) => path.basename(p).startsWith('anthropic.claude-code-'))
    .map((p) => path.join(p, 'resources', 'native-binary', 'claude'));
  const app = subpastas(path.join(casa, 'Library', 'Application Support', 'Claude', 'claude-code'))
    .flatMap((p) => subpastas(p).map((q) => path.join(q, 'claude.app', 'Contents', 'MacOS', 'claude')));
  return [...noPath, ...instalados].find(executavel) ?? [...extensoes, ...app].filter(executavel).sort(compararVersao)[0] ?? null;
}

/**
 * Sem as variáveis da sessão que abriu o servidor, para não herdar outra sessão, e sem chave de API, para a
 * consulta não ser cobrada por fora da assinatura. CLAUDE_CONFIG_DIR fica: é assim que se escolhe outra conta.
 */
export function ambienteDoClaude(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k === 'CLAUDE_CONFIG_DIR' || !/^(CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$)/.test(k)) env[k] = v;
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

export function argumentos({ modelo, esforco, esquema, negados }) {
  return [
    '-p',
    '--model', modelo,
    '--effort', esforco,
    '--tools', 'Read,Grep,Glob',
    '--allowedTools', 'Read,Grep,Glob',
    '--disallowedTools', ...negados,
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(esquema),
    '--settings', JSON.stringify({ claudeMdExcludes: ['**/CLAUDE.md'] }),
  ];
}

export function situacaoDoPrograma() {
  const programa = acharPrograma();
  if (!programa) return Promise.resolve({ disponivel: false });
  const executar = (args) => new Promise((aceitar) => {
    execFile(programa, args, { env: ambienteDoClaude(), timeout: 15000 }, (erro, saida) => aceitar(saida ?? ''));
  });
  return Promise.all([executar(['--version']), executar(['auth', 'status'])]).then(([v, conta]) => {
    const versao = /\d+\.\d+\.\d+/.exec(v)?.[0] ?? null;
    try {
      const d = JSON.parse(conta);
      return { disponivel: Boolean(d.loggedIn), versao, dominio: (d.email ?? '').split('@')[1] ?? null, plano: d.subscriptionType ?? null };
    } catch {
      return { disponivel: false, versao };
    }
  });
}

// ---- os pedidos

const REGRAS_DE_LEITURA = `- Você só tem Read, Grep e Glob. Nada de escrever, executar ou acessar a rede.
- O CLAUDE.md da raiz, se existir, é o guia do projeto e não foi carregado, para economizar: use Grep nele para achar o trecho da área e leia só as linhas em volta.
- Alguns arquivos estão bloqueados, como os que o git ignora: podem ter dados pessoais ou chaves. Não tente contornar o bloqueio.
- Seja econômico: leia o necessário para responder bem, sem varrer o projeto.`;

export function pedidoDeRevisao({ titulo, secao, prompt, modelos, regras = [] }) {
  const criterios = modelos.map((m) => `- "${m.nome}": ${m.quando}.`).join('\n');
  const extras = regras.map((r) => `- ${r}`).join('\n');
  return `Você vai revisar um prompt que a pessoa escreveu para usar depois, em outra sessão do Claude Code, neste projeto. Não execute a tarefa nem proponha código: o seu trabalho é só melhorar o pedido.

COMO TRABALHAR
${REGRAS_DE_LEITURA}
- Leia o código e a documentação para conferir o que o prompt pressupõe: o que já existe, o que falta e quais arquivos, funções e telas estão envolvidos.

COMO REVISAR
- Preserve a intenção da pessoa. Não amplie o escopo nem acrescente o que ela não pediu.
- Se algo pedido já existir, diga isso em "mudancas" e ajuste o prompt.
- Cite só arquivos, funções e telas que você conferiu. Inclua as convenções do projeto que afetam esta tarefa, sem repetir as demais, porque a outra sessão já lê o CLAUDE.md.
- Escreva em português, com frases curtas e diretas: primeiro o pedido, depois o contexto útil, as restrições e como conferir o resultado. O modelo recomendado não entra no prompt. Cada parágrafo fica numa linha só.
- Uma decisão que só a pessoa pode tomar vai em "duvidas", nunca inventada. Uma escolha sua vai em "interpretacoes".
- Trabalho grande ou com decisões abertas: o prompt pede um plano antes de codar.
${extras}

MODELO RECOMENDADO
${criterios}

A TAREFA
Título: ${titulo || '(sem título)'}
Seção da lista: ${secao}
Prompt da pessoa, entre as marcas:
<<<
${prompt}
>>>

Responda só pelo formato pedido. Em "dependeDe", cite outra tarefa ou condição real, ou deixe vazio. Em "titulo", um nome curto, de até 60 caracteres, sem número.`;
}

export const esquemaDaRevisao = (nomes) => ({
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    prompt: { type: 'string' },
    mudancas: { type: 'array', items: { type: 'string' } },
    duvidas: { type: 'array', items: { type: 'string' } },
    interpretacoes: { type: 'array', items: { type: 'string' } },
    modelo: { type: 'string', enum: nomes },
    motivoModelo: { type: 'string' },
    dependeDe: { type: 'string' },
  },
  required: ['titulo', 'prompt', 'mudancas', 'duvidas', 'interpretacoes', 'modelo', 'motivoModelo', 'dependeDe'],
  additionalProperties: false,
});

export function pedidoDeConferencia({ tarefas, commits }) {
  const lista = tarefas.map((t) => `[${t.id}] ${t.titulo}\n${t.prompt.slice(0, CARACTERES_POR_TAREFA)}`).join('\n\n');
  return `Confira, só lendo o projeto, quais das tarefas abaixo já foram feitas. Não execute nenhuma tarefa e não proponha código.

COMO TRABALHAR
${REGRAS_DE_LEITURA}
- A lista de commits recentes, no fim, é o melhor ponto de partida. Mesmo assim, confira no código antes de afirmar que algo existe: um commit parecido não prova que a tarefa inteira foi feita.

COMO DECIDIR
- "feita": tudo o que a tarefa pede existe no código.
- "em_parte": uma parte existe. Diga em "feito" o que existe e em "falta" o que sobrou, em poucas palavras.
- "nao_feita": você não achou, ou a tarefa é um estudo, um plano ou uma carga cuja entrega não dá para conferir no código.
- Na dúvida, escolha a situação menos avançada.
- "confianca" é "alta" só com evidência direta no código; senão, "media".
- "evidencia": uma frase com o arquivo, a função ou o commit. Em "nao_feita", pode ficar vazia.

Responda todas as tarefas, pelo id entre colchetes.

TAREFAS

${lista}

COMMITS RECENTES

${commits || '(este projeto não tem histórico do git)'}`;
}

export const ESQUEMA_CONFERENCIA = {
  type: 'object',
  properties: {
    tarefas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          situacao: { type: 'string', enum: ['feita', 'em_parte', 'nao_feita'] },
          confianca: { type: 'string', enum: ['alta', 'media'] },
          evidencia: { type: 'string' },
          feito: { type: 'string' },
          falta: { type: 'string' },
        },
        required: ['id', 'situacao', 'confianca', 'evidencia', 'feito', 'falta'],
        additionalProperties: false,
      },
    },
  },
  required: ['tarefas'],
  additionalProperties: false,
};

// ---- o andamento

function descreverFerramenta(uso, raiz) {
  const curto = (p) => String(p ?? '').replace(`${raiz}/`, '');
  const i = uso.input ?? {};
  if (uso.name === 'Read') return `Lendo ${curto(i.file_path)}`;
  if (uso.name === 'Grep') return `Buscando "${i.pattern}"`;
  if (uso.name === 'Glob') return `Procurando ${i.pattern}`;
  if (uso.name === 'StructuredOutput') return 'Escrevendo a resposta';
  return uso.name;
}

/** Traduz uma linha do stream-json no que muda no andamento. */
export function interpretarEvento(e, raiz) {
  if (e.type === 'assistant') {
    const usos = (e.message?.content ?? []).filter((c) => c.type === 'tool_use');
    if (!usos.length) return {};
    return { passos: usos.filter((u) => u.name !== 'StructuredOutput').length, atividade: descreverFerramenta(usos.at(-1), raiz) };
  }
  if (e.type === 'rate_limit_event') {
    const uso = e.rate_limit_info?.unifiedWindows?.seven_day?.utilization;
    return typeof uso === 'number' ? { usoSemanal: uso } : {};
  }
  if (e.type === 'result') {
    return {
      fim: true,
      erro: e.is_error ? String(e.result || 'O Claude respondeu com erro.') : null,
      saida: e.structured_output ?? null,
      custo: e.total_cost_usd ?? null,
    };
  }
  return {};
}

/** Uma versão antiga do Claude Code recusa as opções: a frase diz o que fazer, em vez de mostrar o erro cru. */
export function explicarErroDoPrograma(texto) {
  const erro = texto.trim();
  if (/unknown option|unrecognized option/i.test(erro)) return 'Esta versão do Claude Code não tem uma opção que a página usa. Atualize o Claude Code e tente de novo.';
  return erro || 'O Claude terminou sem resposta.';
}

// ---- um trabalho de cada vez

let atual = null;

const vistaDoTrabalho = (t) => t && {
  id: t.id, tipo: t.tipo, estado: t.estado, modelo: t.modelo, esforco: t.esforco, inicio: t.inicio, fim: t.fim,
  passos: t.passos, atividade: t.atividade, erro: t.erro, resultado: t.resultado, custo: t.custo,
  usoSemanal: t.usoSemanal, entrada: t.entrada,
};

export const trabalhoAtual = () => vistaDoTrabalho(atual);

export function limparTrabalho() {
  if (atual?.estado !== 'rodando') atual = null;
}

export function cancelarTrabalho() {
  if (atual?.estado !== 'rodando') return false;
  atual.cancelado = true;
  atual.filho.kill('SIGTERM');
  return true;
}

export function iniciarTrabalho({ tipo, pedido, modelo, esforco, esquema, negados, entrada, raiz }) {
  if (atual?.estado === 'rodando') throw new Error('Já há uma consulta ao Claude em andamento. Espere ou cancele.');
  if (!ESFORCOS.includes(esforco)) throw new Error('Esforço inválido.');
  const programa = acharPrograma();
  if (!programa) throw new Error('Não achei o Claude Code neste computador.');

  const filho = spawn(programa, argumentos({ modelo, esforco, esquema, negados }), { cwd: raiz, env: ambienteDoClaude(), stdio: ['pipe', 'pipe', 'pipe'] });
  const trabalho = {
    id: Date.now().toString(36), tipo, estado: 'rodando', modelo, esforco, inicio: Date.now(), fim: null, passos: 0,
    atividade: 'Abrindo o Claude Code', erro: null, resultado: null, custo: null, usoSemanal: null, entrada, filho, cancelado: false,
  };
  atual = trabalho;

  let final = null;
  let erros = '';
  const limite = setTimeout(() => {
    trabalho.estourou = true;
    filho.kill('SIGTERM');
  }, MINUTOS_MAXIMOS * 60000);

  const concluir = (estado, campos = {}) => {
    if (trabalho.estado !== 'rodando') return;
    clearTimeout(limite);
    Object.assign(trabalho, { estado, fim: Date.now() }, campos);
  };

  readline.createInterface({ input: filho.stdout }).on('line', (linha) => {
    let evento;
    try { evento = JSON.parse(linha); } catch { return; }
    const m = interpretarEvento(evento, raiz);
    if (m.passos) trabalho.passos += m.passos;
    if (m.atividade) trabalho.atividade = m.atividade;
    if (m.usoSemanal != null) trabalho.usoSemanal = m.usoSemanal;
    if (m.fim) final = m;
  });
  filho.stderr.on('data', (p) => { erros = (erros + p).slice(-600); });
  filho.on('error', (e) => concluir('erro', { erro: e.message }));
  filho.on('close', () => {
    if (trabalho.cancelado) concluir('cancelado');
    else if (trabalho.estourou) concluir('erro', { erro: `A consulta passou de ${MINUTOS_MAXIMOS} minutos e foi interrompida.` });
    else if (final?.erro) concluir('erro', { erro: final.erro, custo: final.custo });
    else if (final?.saida) concluir('pronto', { resultado: final.saida, custo: final.custo });
    else concluir('erro', { erro: explicarErroDoPrograma(erros) });
  });
  filho.stdin.on('error', () => {});
  filho.stdin.end(pedido);
  return vistaDoTrabalho(trabalho);
}
