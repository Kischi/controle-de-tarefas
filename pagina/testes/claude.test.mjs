/** Testes da chamada ao Claude, sem chamar o Claude. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ESFORCOS, acharPrograma, ambienteDoClaude, argumentos, esquemaDaRevisao, explicarErroDoPrograma, interpretarEvento, pedidoDeConferencia, pedidoDeRevisao,
} from '../claude.mjs';
import { CONFIG_PADRAO } from '../projeto.mjs';

const RAIZ = '/projeto';
const negados = ['Read(./dados/**)', 'Grep(./dados/**)'];
const args = argumentos({ modelo: 'opus', esforco: 'max', esquema: esquemaDaRevisao(['Opus']), negados });
const depoisDe = (nome) => args[args.indexOf(nome) + 1];

test('o Claude só recebe ferramentas de leitura', () => {
  assert.equal(depoisDe('--tools'), 'Read,Grep,Glob');
  assert.equal(depoisDe('--permission-mode'), 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('as regras de leitura negada chegam ao comando, e o CLAUDE.md não é carregado inteiro', () => {
  assert.ok(args.includes('Read(./dados/**)'));
  assert.ok(args.includes('Grep(./dados/**)'));
  assert.deepEqual(JSON.parse(depoisDe('--settings')), { claudeMdExcludes: ['**/CLAUDE.md'] });
});

test('o modelo e o esforço escolhidos chegam ao comando', () => {
  assert.equal(depoisDe('--model'), 'opus');
  assert.equal(depoisDe('--effort'), 'max');
  assert.deepEqual(ESFORCOS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('os modelos da revisão vêm da configuração do projeto', () => {
  assert.deepEqual(esquemaDaRevisao(['A', 'B']).properties.modelo.enum, ['A', 'B']);
  const p = pedidoDeRevisao({ titulo: 'T', secao: 'S', prompt: 'P', modelos: [{ nome: 'A', quando: 'quando couber' }], regras: ['Uma regra do projeto.'] });
  assert.match(p, /- "A": quando couber\./);
  assert.match(p, /- Uma regra do projeto\./);
});

test('as variáveis de quem abriu o servidor não vazam, e a memória fica de fora', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/outra' };
  assert.deepEqual(ambienteDoClaude(base), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/outra', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
});

test('o programa pode ser indicado por uma variável', () => {
  assert.equal(acharPrograma({ TAREFAS_CLAUDE_BIN: '/opt/claude', PATH: '' }), '/opt/claude');
});

test('o pedido de revisão leva o texto da pessoa e as regras que importam', () => {
  const p = pedidoDeRevisao({ titulo: 'Um título', secao: 'Pequenos ajustes', prompt: 'Trocar o botão.', modelos: CONFIG_PADRAO.modelosDeTarefa, regras: CONFIG_PADRAO.regrasDaRevisao });
  assert.match(p, /Título: Um título/);
  assert.match(p, /<<<\nTrocar o botão\.\n>>>/);
  assert.match(p, /CLAUDE\.md/);
  assert.match(p, /Não execute a tarefa/);
  assert.match(p, /Fable no plano/);
  assert.match(p, /Quando necessário o uso de sub-agentes/);
});

test('o pedido de conferência corta os prompts longos e leva os commits', () => {
  const p = pedidoDeConferencia({ tarefas: [{ id: 't1', titulo: 'Tarefa', prompt: 'a'.repeat(5000) }], commits: 'abc123 2026-11-02 Um commit' });
  assert.match(p, /\[t1\] Tarefa/);
  assert.ok(p.length < 3500);
  assert.match(p, /abc123 2026-11-02 Um commit/);
  assert.match(p, /Na dúvida, escolha a situação menos avançada/);
  assert.match(pedidoDeConferencia({ tarefas: [], commits: '' }), /não tem histórico do git/);
});

test('o andamento vem das ferramentas usadas, sem o caminho inteiro', () => {
  const leitura = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${RAIZ}/src/x.ts` } }] } };
  assert.deepEqual(interpretarEvento(leitura, RAIZ), { passos: 1, atividade: 'Lendo src/x.ts' });
  const final = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: {} }] } };
  assert.deepEqual(interpretarEvento(final, RAIZ), { passos: 0, atividade: 'Escrevendo a resposta' });
  assert.deepEqual(interpretarEvento({ type: 'assistant', message: { content: [{ type: 'text', text: 'oi' }] } }, RAIZ), {});
});

test('o resultado traz a resposta, o custo e o erro', () => {
  const ok = interpretarEvento({ type: 'result', is_error: false, structured_output: { a: 1 }, total_cost_usd: 0.5 }, RAIZ);
  assert.deepEqual(ok, { fim: true, erro: null, saida: { a: 1 }, custo: 0.5 });
  assert.equal(interpretarEvento({ type: 'result', is_error: true, result: 'Limite atingido' }, RAIZ).erro, 'Limite atingido');
  assert.equal(interpretarEvento({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.4 } } } }, RAIZ).usoSemanal, 0.4);
});

test('uma versão antiga do Claude Code ganha uma frase que diz o que fazer', () => {
  assert.match(explicarErroDoPrograma("error: unknown option '--effort'"), /Atualize o Claude Code/);
  assert.equal(explicarErroDoPrograma('outro erro'), 'outro erro');
  assert.equal(explicarErroDoPrograma('  '), 'O Claude terminou sem resposta.');
});
