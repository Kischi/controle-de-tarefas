/** Testes do que depende do projeto, em pastas temporárias, com git de verdade. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_PADRAO, caminhosDoProjeto, commitsRecentes, lerConfig, portaDoProjeto, raizDoProjeto, regrasDeLeituraNegada } from '../projeto.mjs';

const SERVIDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'servidor.mjs');
const pastas = [];
const pastaNova = (nome = 'Projeto Ação') => {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tarefas-')));
  pastas.push(p);
  const dentro = path.join(p, nome);
  fs.mkdirSync(dentro);
  return dentro;
};
test.after(() => { for (const p of pastas) fs.rmSync(p, { recursive: true, force: true }); });

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.st', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const comando = (cwd, ...a) => spawnSync(process.execPath, [SERVIDOR, ...a], { cwd, encoding: 'utf8' });

function repositorio() {
  const raiz = pastaNova();
  git(raiz, 'init', '-q');
  fs.writeFileSync(path.join(raiz, '.gitignore'), 'dados/\nsegredo.txt\n');
  fs.writeFileSync(path.join(raiz, 'a.txt'), 'a\n');
  fs.mkdirSync(path.join(raiz, 'dados'));
  fs.writeFileSync(path.join(raiz, 'dados', 'alunos.csv'), 'x\n');
  fs.writeFileSync(path.join(raiz, 'segredo.txt'), 'x\n');
  git(raiz, 'add', '.');
  git(raiz, 'commit', '-qm', 'Primeiro commit');
  return raiz;
}

test('sem git, o projeto é a pasta pedida', () => {
  const p = pastaNova();
  assert.equal(raizDoProjeto(p), p);
});

test('numa subpasta, o projeto é a raiz do repositório', () => {
  const raiz = repositorio();
  fs.mkdirSync(path.join(raiz, 'src'));
  assert.equal(raizDoProjeto(path.join(raiz, 'src')), raiz);
});

test('numa worktree, o projeto é a pasta principal, onde a lista mora', () => {
  const raiz = repositorio();
  const outra = path.join(path.dirname(raiz), 'outra-arvore');
  git(raiz, 'worktree', 'add', '-q', outra);
  assert.equal(raizDoProjeto(outra), raiz);
});

test('cada projeto tem a sua porta, que não muda', () => {
  assert.equal(portaDoProjeto('/um'), portaDoProjeto('/um'));
  assert.ok(portaDoProjeto('/um') >= 8700 && portaDoProjeto('/um') < 8900);
  assert.notEqual(portaDoProjeto('/projeto-a'), portaDoProjeto('/projeto-b'));
});

test('a configuração completa o que falta com o padrão', () => {
  const p = pastaNova();
  const arq = path.join(p, 'config.json');
  assert.deepEqual(lerConfig(arq), CONFIG_PADRAO);
  fs.writeFileSync(arq, JSON.stringify({ revisao: { esforco: 'low' }, leituraNegada: ['./x/**'] }));
  const c = lerConfig(arq);
  assert.deepEqual(c.revisao, { modelo: 'opus', esforco: 'low' });
  assert.deepEqual(c.leituraNegada, ['./x/**']);
  assert.deepEqual(c.modelosDeTarefa, CONFIG_PADRAO.modelosDeTarefa);
  fs.writeFileSync(arq, '{ quebrado');
  assert.deepEqual(lerConfig(arq), CONFIG_PADRAO);
});

test('o que o git ignora, a lista e os segredos comuns ficam fora da leitura do Claude', () => {
  const raiz = repositorio();
  const regras = regrasDeLeituraNegada(raiz, ['./extra/**']);
  for (const r of ['Read(./dados/**)', 'Grep(./dados/**)', 'Glob(./dados/**)', 'Read(./segredo.txt)', 'Read(./extra/**)', 'Read(./.tarefas/**)', 'Read(**/.env)']) {
    assert.ok(regras.includes(r), r);
  }
  assert.equal(regras.includes('Read(./a.txt)'), false);
});

test('sem git, valem os segredos comuns e os extras', () => {
  const regras = regrasDeLeituraNegada(pastaNova(), ['./x/**']);
  assert.ok(regras.includes('Read(**/*.pem)'));
  assert.ok(regras.includes('Read(./x/**)'));
});

test('muitos ignorados viram as pastas de cima, para o comando não estourar', () => {
  const raiz = repositorio();
  fs.writeFileSync(path.join(raiz, '.gitignore'), 'log-*.txt\n');
  fs.mkdirSync(path.join(raiz, 'logs'));
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(raiz, 'logs', `log-${i}.txt`), 'x');
  const regras = regrasDeLeituraNegada(raiz);
  assert.ok(regras.includes('Read(./logs/**)'));
  assert.ok(regras.length < 200);
});

test('os commits vêm do git, e um projeto sem git não quebra', () => {
  assert.match(commitsRecentes(repositorio(), 5), /Primeiro commit/);
  assert.equal(commitsRecentes(pastaNova(), 5), '');
});

test('criar não muda nenhum arquivo versionado, e a pasta fica fora do git', () => {
  const raiz = repositorio();
  const r = comando(raiz, 'criar');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(raiz, 'status', '--porcelain'), '');
  const P = caminhosDoProjeto(raiz);
  assert.ok(fs.existsSync(P.arquivo));
  assert.deepEqual(JSON.parse(fs.readFileSync(P.config, 'utf8')), CONFIG_PADRAO);
  const antes = fs.readFileSync(P.arquivo, 'utf8');
  assert.match(comando(raiz, 'criar').stdout, /já tem lista/);
  assert.equal(fs.readFileSync(P.arquivo, 'utf8'), antes);
});

test('os comandos adicionam, listam, movem e registram, com cópia antes de cada gravação', () => {
  const raiz = pastaNova();
  comando(raiz, 'criar', '--secoes', 'Agora|Depois|Feitos');
  const add = spawnSync(process.execPath, [SERVIDOR, 'adicionar', '--titulo', 'Trocar o botão', '--secao', '1', '--modelo', 'Opus', '--motivo', 'É simples.'], {
    cwd: raiz, encoding: 'utf8', input: 'Trocar o "botão" de $lugar.\n\nSegundo parágrafo.\n',
  });
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /t1/);
  assert.equal(comando(raiz, 'adicionar', '--titulo', 'Só com a opção', '--secao', '2', '--prompt', 'Texto curto.').status, 0);
  assert.match(fs.readFileSync(caminhosDoProjeto(raiz).arquivo, 'utf8'), /```text\nTrocar o "botão" de \$lugar\.\n\nSegundo parágrafo\.\n```/);
  assert.match(comando(raiz, 'listar').stdout, /t1 \[pendente\] Trocar o botão/);
  assert.equal(comando(raiz, 'mover', 't1', '2').status, 0);
  assert.equal(comando(raiz, 'parte', 't1', '--feito', 'A tela.', '--falta', 'O teste.').status, 0);
  assert.equal(comando(raiz, 'feito', 't1', '--registro', 'commit abc1234').status, 0);
  const P = caminhosDoProjeto(raiz);
  const texto = fs.readFileSync(P.arquivo, 'utf8');
  assert.match(texto, /Feito em \d\d\/\d\d\/\d{4} \(commit abc1234\)\. Antes: Feito em parte/);
  assert.ok(fs.readdirSync(path.join(P.pasta, '.copias')).length >= 3);
});

test('um comando sem lista diz como criar, e um id errado é recusado', () => {
  const raiz = pastaNova();
  const r = comando(raiz, 'listar');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /criar/);
  comando(raiz, 'criar');
  assert.match(comando(raiz, 'feito', 't99').stderr, /tarefa/);
  assert.match(comando(raiz, 'feito').stderr, /id da tarefa/);
});

test('a situação diz o que existe, em JSON', () => {
  const raiz = pastaNova();
  assert.equal(JSON.parse(comando(raiz, 'situacao').stdout).existe, false);
  comando(raiz, 'criar');
  const s = JSON.parse(comando(raiz, 'situacao').stdout);
  assert.equal(s.existe, true);
  assert.equal(s.rodando, false);
  assert.equal(s.secoes.length, 7);
});
