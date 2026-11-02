#!/usr/bin/env node
/**
 * O controle de tarefas de um projeto. Sem dependências, só o Node:
 *
 *   servidor.mjs criar [--secoes "A|B|Feitos"]     cria .tarefas/ no projeto
 *   servidor.mjs abrir [--navegador]               liga a página em segundo plano e mostra o endereço
 *   servidor.mjs rodar [--porta 8712]              liga a página neste terminal, até o Ctrl+C
 *   servidor.mjs parar                             desliga a página do projeto
 *   servidor.mjs situacao                          o estado do projeto, em JSON
 *   servidor.mjs listar                            as seções e as tarefas, com os ids
 *   servidor.mjs adicionar --titulo "..." --secao 3 [--modelo Opus] [--motivo "..."] [--depende "..."] [--notas "..."]
 *                                                  o prompt vem da entrada padrão, ou de --prompt "..."
 *   servidor.mjs mover t12 3                       leva a tarefa à seção 3
 *   servidor.mjs feito t12 [--registro "commit abc1234; publicado: não"]
 *   servidor.mjs parte t12 --feito "..." --falta "..." [--registro "..."]
 *
 * O projeto é a pasta atual, ou a de --projeto; numa worktree, a pasta principal do repositório.
 *
 * Só atende nesta máquina (127.0.0.1). O .md continua sendo a fonte oficial: cada mudança relê o arquivo,
 * confere se ele mudou desde que a página o leu, guarda uma cópia em .copias/ e grava de uma vez.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ESFORCOS, ESQUEMA_CONFERENCIA, acharPrograma, cancelarTrabalho, esquemaDaRevisao, iniciarTrabalho, limparTrabalho,
  pedidoDeConferencia, pedidoDeRevisao, situacaoDoPrograma, trabalhoAtual,
} from './claude.mjs';
import {
  acrescentarTarefa, conferir, documentoNovo, hash, marcarEmParte, marcarFeita, moverTarefa, paraPagina, parsear, resolverTarefas,
  secoesDoPedido, serializar, tarefasParaConferir,
} from './md.mjs';
import {
  CONFIG_PADRAO, caminhosDoProjeto, commitsRecentes, lerConfig, portaDoProjeto, raizDoProjeto, regrasDeLeituraNegada,
} from './projeto.mjs';

const ESTE_ARQUIVO = fileURLToPath(import.meta.url);
const PASTA_DO_CODIGO = path.dirname(ESTE_ARQUIVO);
const COPIAS_GUARDADAS = 40;
const LIMITE_PEDIDO = 256 * 1024;
const COMMITS_NA_CONFERENCIA = 300;
const PORTAS_DE_RESERVA = 20;

const argv = process.argv.slice(2);
const opcao = (nome) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const tem = (nome) => argv.includes(`--${nome}`);
const posicionais = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const [COMANDO = 'ajuda', ...RESTO] = posicionais;

const P = caminhosDoProjeto(raizDoProjeto(opcao('projeto') ?? process.cwd()));
const COMANDO_NO_ARQUIVO = `node "${ESTE_ARQUIVO}"`;

const hoje = () => new Date().toLocaleDateString('pt-BR');
const esperar = (ms) => new Promise((aceitar) => { setTimeout(aceitar, ms); });
const lerTexto = () => fs.readFileSync(P.arquivo, 'utf8');
const config = () => lerConfig(P.config);

function exigirLista() {
  if (!fs.existsSync(P.arquivo)) throw new Error(`Este projeto ainda não tem lista (${P.arquivo}). Crie com: ${COMANDO_NO_ARQUIVO} criar`);
}

// ---- gravar

function guardarCopia(texto) {
  const pasta = path.join(P.pasta, '.copias');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`), texto);
  const velhas = fs.readdirSync(pasta).filter((n) => /^\d{4}-.*\.md$/.test(n)).sort().reverse().slice(COPIAS_GUARDADAS);
  for (const n of velhas) fs.unlinkSync(path.join(pasta, n));
}

function escrever(antes, depois) {
  guardarCopia(antes);
  const temporario = `${P.arquivo}.gravando`;
  fs.writeFileSync(temporario, depois);
  fs.renameSync(temporario, P.arquivo);
}

function gravar(antes, depois, opcoes) {
  conferir(antes, depois, opcoes);
  escrever(antes, depois);
}

/** Para os comandos: lê, muda, confere e grava, com a mesma trava da página. */
function mudarArquivo(mudar, opcoes) {
  exigirLista();
  const antes = lerTexto();
  const doc = parsear(antes);
  const resultado = mudar(doc);
  const depois = serializar(doc);
  if (depois !== antes) gravar(antes, depois, opcoes);
  return resultado;
}

// ---- a página

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ROTAS_ESTATICAS = { '/': 'index.html', '/app.js': 'app.js', '/janelas.js': 'janelas.js', '/estilo.css': 'estilo.css' };
const ARQUIVOS_DO_CODIGO = [...Object.values(ROTAS_ESTATICAS), 'servidor.mjs', 'md.mjs', 'claude.mjs', 'projeto.mjs'];
const SEGURANCA = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const versaoDoCodigo = () => hash(ARQUIVOS_DO_CODIGO.map((n) => fs.readFileSync(path.join(PASTA_DO_CODIGO, n), 'utf8')).join('\0'));

function responderJson(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function lerCorpo(req) {
  return new Promise((aceitar, recusar) => {
    let dados = '';
    req.on('data', (parte) => {
      dados += parte;
      if (dados.length > LIMITE_PEDIDO) { recusar(new Error('Pedido grande demais.')); req.destroy(); }
    });
    req.on('end', () => aceitar(dados));
    req.on('error', recusar);
  });
}

/** Para o Desfazer da conferência, que move várias tarefas de uma vez. */
let ultimaMudanca = null;

function atender(porta) {
  const hosts = new Set([`127.0.0.1:${porta}`, `localhost:${porta}`]);
  const origens = new Set([...hosts].map((h) => `http://${h}`));
  // A página e o servidor ficam da mesma versão enquanto ele viver, mesmo que a skill seja atualizada no disco.
  const estaticos = Object.fromEntries(Object.entries(ROTAS_ESTATICAS).map(([rota, nome]) => [
    rota, { conteudo: fs.readFileSync(path.join(PASTA_DO_CODIGO, nome)), tipo: TIPOS[path.extname(nome)] },
  ]));
  const codigo = versaoDoCodigo();

  const documento = (texto) => ({ ...paraPagina(parsear(texto), texto), arquivo: P.arquivo, projeto: P.nome });

  /** Relê o arquivo e recusa se ele mudou desde que a página o leu. */
  const abrirParaMudar = (res, pedido) => {
    const antes = lerTexto();
    if (pedido.versao !== hash(antes)) {
      responderJson(res, 409, { erro: 'O arquivo mudou enquanto a página estava aberta. Confira a lista e repita.', ...documento(antes) });
      return null;
    }
    return { antes, doc: parsear(antes) };
  };

  const rotasPost = {
    '/api/mover': (res, pedido) => {
      const aberto = abrirParaMudar(res, pedido);
      if (!aberto) return;
      const mudou = moverTarefa(aberto.doc, pedido.id, pedido.para, pedido.antesDe ?? null, hoje());
      const depois = mudou ? serializar(aberto.doc) : aberto.antes;
      if (mudou) gravar(aberto.antes, depois);
      responderJson(res, 200, documento(depois));
    },
    '/api/tarefa': (res, pedido) => {
      const aberto = abrirParaMudar(res, pedido);
      if (!aberto) return;
      const id = acrescentarTarefa(aberto.doc, { ...pedido, para: pedido.grupo });
      const depois = serializar(aberto.doc);
      gravar(aberto.antes, depois, { novas: 1 });
      responderJson(res, 200, { ...documento(depois), novaTarefa: id });
    },
    '/api/resolver': (res, pedido) => {
      const aberto = abrirParaMudar(res, pedido);
      if (!aberto) return;
      resolverTarefas(aberto.doc, { feitas: pedido.feitas, parciais: pedido.parciais }, hoje());
      const depois = serializar(aberto.doc);
      gravar(aberto.antes, depois);
      ultimaMudanca = { antes: aberto.antes, versao: hash(depois) };
      responderJson(res, 200, documento(depois));
    },
    '/api/desfazer': (res) => {
      const agora = lerTexto();
      if (!ultimaMudanca || ultimaMudanca.versao !== hash(agora)) {
        responderJson(res, 409, { erro: 'O arquivo mudou depois disso. Use as cópias em .copias/.', ...documento(agora) });
        return;
      }
      const { antes } = ultimaMudanca;
      escrever(agora, antes);
      ultimaMudanca = null;
      responderJson(res, 200, documento(antes));
    },
    '/api/revisar': (res, pedido) => {
      const prompt = String(pedido.prompt ?? '').trim();
      if (!prompt) { responderJson(res, 400, { erro: 'Escreva o prompt básico antes de revisar.' }); return; }
      const texto = lerTexto();
      const grupo = paraPagina(parsear(texto), texto).grupos.find((g) => g.id === pedido.grupo);
      const c = config();
      responderJson(res, 200, iniciarTrabalho({
        tipo: 'revisao',
        pedido: pedidoDeRevisao({ titulo: pedido.titulo, secao: grupo?.nome ?? '', prompt, modelos: c.modelosDeTarefa, regras: c.regrasDaRevisao }),
        modelo: c.revisao.modelo,
        esforco: pedido.esforco,
        esquema: esquemaDaRevisao(c.modelosDeTarefa.map((m) => m.nome)),
        negados: regrasDeLeituraNegada(P.raiz, c.leituraNegada),
        entrada: { titulo: pedido.titulo ?? '', grupo: pedido.grupo, prompt },
        raiz: P.raiz,
      }));
    },
    '/api/conferir': (res, pedido) => {
      const tarefas = tarefasParaConferir(parsear(lerTexto()), pedido.ids);
      if (!tarefas.length) { responderJson(res, 400, { erro: 'Não há tarefas abertas com prompt para conferir.' }); return; }
      const c = config();
      responderJson(res, 200, iniciarTrabalho({
        tipo: 'conferencia',
        pedido: pedidoDeConferencia({ tarefas, commits: commitsRecentes(P.raiz, COMMITS_NA_CONFERENCIA) }),
        modelo: c.conferencia.modelo,
        esforco: pedido.esforco,
        esquema: ESQUEMA_CONFERENCIA,
        negados: regrasDeLeituraNegada(P.raiz, c.leituraNegada),
        entrada: { quantas: tarefas.length },
        raiz: P.raiz,
      }));
    },
    '/api/trabalho/cancelar': (res) => responderJson(res, 200, { cancelado: cancelarTrabalho() }),
    '/api/trabalho/limpar': (res) => { limparTrabalho(); responderJson(res, 200, {}); },
  };

  return async (req, res) => {
    try {
      // Outro site aberto no navegador não pode falar com este servidor.
      if (!hosts.has(req.headers.host ?? '')) { responderJson(res, 403, { erro: 'Endereço não permitido.' }); return; }
      const rota = new URL(req.url, `http://127.0.0.1:${porta}`).pathname;

      if (req.method === 'GET' && estaticos[rota]) {
        res.writeHead(200, { 'Content-Type': estaticos[rota].tipo, 'Cache-Control': 'no-store', ...SEGURANCA });
        res.end(estaticos[rota].conteudo);
        return;
      }
      if (req.method === 'GET' && rota === '/api/versao') {
        responderJson(res, 200, { lista: true, versao: hash(lerTexto()), arquivo: P.arquivo, codigo, pid: process.pid });
        return;
      }
      if (req.method === 'GET' && rota === '/api/lista') {
        responderJson(res, 200, documento(lerTexto()));
        return;
      }
      if (req.method === 'GET' && rota === '/api/trabalho') {
        responderJson(res, 200, { trabalho: trabalhoAtual() });
        return;
      }
      if (req.method === 'GET' && rota === '/api/claude') {
        const c = config();
        responderJson(res, 200, {
          ...(await situacaoDoPrograma()), esforcos: ESFORCOS, modelos: c.modelosDeTarefa.map((m) => m.nome), revisao: c.revisao, conferencia: c.conferencia,
        });
        return;
      }
      if (req.method === 'POST' && rotasPost[rota]) {
        const origem = req.headers.origin;
        if (origem && !origens.has(origem)) { responderJson(res, 403, { erro: 'Origem não permitida.' }); return; }
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
          responderJson(res, 415, { erro: 'Pedido inválido.' });
          return;
        }
        await rotasPost[rota](res, JSON.parse((await lerCorpo(req)) || '{}'));
        return;
      }
      responderJson(res, 404, { erro: 'Não achei isso.' });
    } catch (erro) {
      responderJson(res, 500, { erro: erro.message });
    }
  };
}

function sondar(porta) {
  return new Promise((aceitar) => {
    const pedido = http.get({ host: '127.0.0.1', port: porta, path: '/api/versao', timeout: 1500 }, (r) => {
      let dados = '';
      r.on('data', (p) => { dados += p; });
      r.on('end', () => {
        try {
          const d = JSON.parse(dados);
          aceitar(d.lista === true ? d : null);
        } catch { aceitar(null); }
      });
    });
    pedido.on('error', () => aceitar(null));
    pedido.on('timeout', () => { pedido.destroy(); aceitar(null); });
  });
}

function lerEstado() {
  try { return JSON.parse(fs.readFileSync(P.estado, 'utf8')); } catch { return null; }
}

function apagarEstado() {
  if (lerEstado()?.pid === process.pid) fs.rmSync(P.estado, { force: true });
}

function escutar(porta, reservas) {
  const servidor = http.createServer(atender(porta));
  servidor.on('error', async (erro) => {
    if (erro.code === 'EADDRINUSE' && reservas > 0) {
      const outro = await sondar(porta);
      if (outro?.arquivo === P.arquivo) { console.log(`A lista já está aberta em http://127.0.0.1:${porta}`); return; }
      escutar(porta + 1, reservas - 1);
      return;
    }
    console.error(`Não consegui abrir a porta ${porta}: ${erro.message}`);
    process.exit(1);
  });
  servidor.listen(porta, '127.0.0.1', () => {
    fs.writeFileSync(P.estado, JSON.stringify({ pid: process.pid, porta }));
    console.log(`Lista de ${P.nome}: http://127.0.0.1:${porta}`);
    console.log(`Arquivo: ${P.arquivo}`);
  });
}

function rodar() {
  exigirLista();
  parsear(lerTexto());
  for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { apagarEstado(); process.exit(0); });
  escutar(Number(opcao('porta') ?? portaDoProjeto(P.raiz)), PORTAS_DE_RESERVA);
}

function abrirNoNavegador(url) {
  const [programa, ...args] = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] }[process.platform] ?? ['xdg-open'];
  const filho = spawn(programa, [...args, url], { stdio: 'ignore', detached: true });
  filho.on('error', () => console.error(`Não consegui abrir o navegador. Abra ${url} à mão.`));
  filho.unref();
}

function mostrarEndereco(porta) {
  const url = `http://127.0.0.1:${porta}`;
  console.log(`Lista de ${P.nome}: ${url}`);
  console.log('No VS Code: Cmd+Shift+P (Ctrl+Shift+P no Windows e no Linux), "Browser: Open Integrated Browser", e cole o endereço.');
  if (tem('navegador')) abrirNoNavegador(url);
}

async function pararProcesso(pid, porta) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 30 && await sondar(porta); i++) await esperar(100);
}

async function abrir() {
  exigirLista();
  const atual = lerEstado();
  const vivo = atual ? await sondar(atual.porta) : null;
  if (vivo?.arquivo === P.arquivo) {
    if (vivo.codigo === versaoDoCodigo()) { mostrarEndereco(atual.porta); return; }
    // A skill foi atualizada: um servidor antigo serviria uma página que não combina com o arquivo em disco.
    await pararProcesso(vivo.pid, atual.porta);
  }
  const log = fs.openSync(P.log, 'a');
  const filho = spawn(process.execPath, [ESTE_ARQUIVO, 'rodar', '--projeto', P.raiz, ...(opcao('porta') ? ['--porta', opcao('porta')] : [])], {
    cwd: P.raiz, detached: true, stdio: ['ignore', log, log],
  });
  filho.unref();
  for (let i = 0; i < 60; i++) {
    await esperar(100);
    const estado = lerEstado();
    if (estado?.pid === filho.pid && await sondar(estado.porta)) { mostrarEndereco(estado.porta); return; }
  }
  throw new Error(`A página não abriu. Veja ${P.log}, ou rode no terminal: ${COMANDO_NO_ARQUIVO} rodar`);
}

async function parar() {
  const atual = lerEstado();
  const vivo = atual ? await sondar(atual.porta) : null;
  if (vivo?.arquivo === P.arquivo) await pararProcesso(vivo.pid, atual.porta);
  fs.rmSync(P.estado, { force: true });
  console.log('A página deste projeto está desligada.');
}

function criar() {
  if (fs.existsSync(P.arquivo)) { console.log(`Este projeto já tem lista: ${P.arquivo}`); return; }
  fs.mkdirSync(P.pasta, { recursive: true });
  // O * esconde a pasta inteira do git, sem mexer em nenhum arquivo versionado do projeto.
  fs.writeFileSync(path.join(P.pasta, '.gitignore'), '*\n');
  if (!fs.existsSync(P.config)) fs.writeFileSync(P.config, `${JSON.stringify(CONFIG_PADRAO, null, 2)}\n`);
  fs.writeFileSync(P.arquivo, documentoNovo({ projeto: P.nome, arquivo: P.arquivo, comando: COMANDO_NO_ARQUIVO, secoes: secoesDoPedido(opcao('secoes')) }));
  console.log(`Lista criada: ${P.arquivo}`);
}

async function situacao() {
  const existe = fs.existsSync(P.arquivo);
  const estado = lerEstado();
  const vivo = estado ? await sondar(estado.porta) : null;
  const rodando = vivo?.arquivo === P.arquivo;
  const doc = existe ? parsear(lerTexto()) : null;
  console.log(JSON.stringify({
    projeto: P.nome,
    raiz: P.raiz,
    existe,
    arquivo: P.arquivo,
    rodando,
    url: rodando ? `http://127.0.0.1:${estado.porta}` : null,
    secoes: doc?.grupos.map((g) => `${g.numero}. ${g.nome}`) ?? [],
    tarefas: doc?.grupos.reduce((n, g) => n + g.tarefas.length, 0) ?? 0,
    claudeCode: Boolean(acharPrograma()),
  }, null, 2));
}

function listar() {
  exigirLista();
  const texto = lerTexto();
  for (const g of paraPagina(parsear(texto), texto).grupos) {
    console.log(`${g.numero}. ${g.nome} (${g.tarefas.length})`);
    for (const t of g.tarefas) console.log(`   ${t.id} [${t.categoria}] ${t.titulo}`);
  }
}

/** O prompt vem como texto puro: o Claude Code barra JSON num heredoc, por parecer ofuscação. */
function lerPrompt() {
  if (opcao('prompt') !== undefined) return opcao('prompt');
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function adicionar() {
  const tarefa = {
    titulo: opcao('titulo'),
    para: opcao('secao'),
    prompt: lerPrompt(),
    modelo: opcao('modelo'),
    motivoModelo: opcao('motivo'),
    dependeDe: opcao('depende'),
    notas: opcao('notas'),
  };
  const id = mudarArquivo((doc) => acrescentarTarefa(doc, tarefa), { novas: 1 });
  console.log(`Tarefa ${id} adicionada.`);
}

function exigirId() {
  if (!RESTO[0]) throw new Error('Diga o id da tarefa, como t12. O comando listar mostra os ids.');
  return RESTO[0];
}

function mover() {
  const id = exigirId();
  if (!RESTO[1]) throw new Error('Diga o número da seção de destino.');
  mudarArquivo((doc) => moverTarefa(doc, id, RESTO[1], null, hoje()));
  console.log(`Tarefa ${id} movida para a seção ${RESTO[1]}.`);
}

function feito() {
  const id = exigirId();
  mudarArquivo((doc) => marcarFeita(doc, id, hoje(), opcao('registro') ?? 'sem registro de commit'));
  console.log(`Tarefa ${id} registrada como feita.`);
}

function parte() {
  const id = exigirId();
  mudarArquivo((doc) => marcarEmParte(doc, id, hoje(), { feito: opcao('feito'), falta: opcao('falta'), registro: opcao('registro') ?? 'sem registro de commit' }));
  console.log(`Tarefa ${id} registrada como feita em parte.`);
}

const COMANDOS = { criar, abrir, rodar, parar, situacao, listar, adicionar, mover, feito, parte };

try {
  const comando = COMANDOS[COMANDO];
  if (!comando) {
    console.log(fs.readFileSync(ESTE_ARQUIVO, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  } else {
    await comando();
  }
} catch (erro) {
  console.error(erro.message);
  process.exit(1);
}
