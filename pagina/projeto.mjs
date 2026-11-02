/**
 * Onde cada coisa fica num projeto. Tudo o que é do projeto mora em .tarefas/, uma pasta que se esconde
 * sozinha do git, com um .gitignore próprio: criar a lista não muda nenhum arquivo versionado.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const NOME_DA_PASTA = '.tarefas';
const PORTA_BASE = 8700;
const PORTAS = 200;
const LIMITE_DE_IGNORADOS = 150;

/** Segredos comuns ficam fora da leitura do Claude mesmo num projeto sem git. */
const SEMPRE_NEGADOS = [
  `./${NOME_DA_PASTA}/**`, '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa', '**/id_ed25519',
];

export const CONFIG_PADRAO = {
  revisao: { modelo: 'opus', esforco: 'max' },
  conferencia: { modelo: 'sonnet', esforco: 'medium' },
  modelosDeTarefa: [
    { nome: 'Sonnet', quando: 'tarefa pequena e bem delimitada, em que o erro aparece logo' },
    { nome: 'Opus', quando: 'o trabalho comum, em que o erro aparece na tela ou nos testes' },
    { nome: 'Fable', quando: 'o que custa caro e é difícil de perceber quando sai errado: dinheiro, permissões, segurança e decisões de arquitetura' },
    { nome: 'Fable no plano', quando: 'quando só o plano tem esse risco, e a execução é comum' },
  ],
  regrasDaRevisao: [
    'Se a tarefa mexer em tela, inclua no prompt: "Todo o design e UX devem ser feitos como um excelente designer profissional faria, em telas de uso fácil e intuitivo, além de esteticamente agradáveis."',
    'Se a tarefa for grande o bastante para usar sub-agentes, termine o prompt com este parágrafo, igual: "Quando necessário o uso de sub-agentes, use o modelo mais apropriado para o trabalho dele, para não desperdiçar a cota do modelo principal."',
  ],
  leituraNegada: [],
};

function git(raiz, ...argumentos) {
  const r = spawnSync('git', ['--no-optional-locks', ...argumentos], { cwd: raiz, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * A pasta principal do projeto. Numa worktree, é a do repositório principal, porque .tarefas/ fica fora do
 * git e só existe lá. Sem git, é a pasta pedida.
 */
export function raizDoProjeto(inicio = process.cwd()) {
  const pasta = fs.realpathSync(path.resolve(inicio));
  const comum = git(pasta, 'rev-parse', '--git-common-dir')?.trim();
  if (comum) {
    const caminho = path.resolve(pasta, comum);
    if (path.basename(caminho) === '.git') return path.dirname(caminho);
    const topo = git(pasta, 'rev-parse', '--show-toplevel')?.trim();
    if (topo) return topo;
  }
  return pasta;
}

export function caminhosDoProjeto(raiz) {
  const pasta = path.join(raiz, NOME_DA_PASTA);
  return {
    raiz,
    pasta,
    nome: path.basename(raiz),
    arquivo: path.join(pasta, 'tarefas.md'),
    config: path.join(pasta, 'config.json'),
    estado: path.join(pasta, 'servidor.json'),
    log: path.join(pasta, 'servidor.log'),
  };
}

/** Cada projeto tem o seu endereço, que não muda, para dois projetos abertos não disputarem a porta. */
export function portaDoProjeto(raiz) {
  const n = createHash('sha256').update(raiz).digest().readUInt32BE(0);
  return PORTA_BASE + (n % PORTAS);
}

export function lerConfig(caminho) {
  let lida = {};
  try { lida = JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch { /* sem o arquivo, vale o padrão */ }
  return {
    ...CONFIG_PADRAO,
    ...lida,
    revisao: { ...CONFIG_PADRAO.revisao, ...lida.revisao },
    conferencia: { ...CONFIG_PADRAO.conferencia, ...lida.conferencia },
  };
}

function ignoradosPeloGit(raiz) {
  const saida = git(raiz, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory');
  if (!saida) return [];
  let caminhos = saida.split('\n').filter(Boolean).map((l) => l.replace(/\/$/, ''));
  if (caminhos.length > LIMITE_DE_IGNORADOS) caminhos = [...new Set(caminhos.map((c) => c.split('/')[0]))];
  return caminhos.flatMap((c) => [`./${c}`, `./${c}/**`]);
}

/**
 * O que o Claude da página não lê: tudo o que o git ignora, porque é onde costumam morar os dados e as
 * chaves, os segredos comuns e o que a pessoa acrescentar em `leituraNegada`.
 */
export function regrasDeLeituraNegada(raiz, extras = []) {
  const caminhos = [...new Set([...SEMPRE_NEGADOS, ...extras, ...ignoradosPeloGit(raiz)])];
  return caminhos.flatMap((c) => [`Read(${c})`, `Grep(${c})`, `Glob(${c})`]);
}

export const commitsRecentes = (raiz, quantos) => {
  const saida = git(raiz, 'log', `-n${quantos}`, '--format=%h %ad %s', '--date=short');
  return saida ? saida.split('\n').map((l) => l.slice(0, 170)).join('\n').trim() : '';
};
