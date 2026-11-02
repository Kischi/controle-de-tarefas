/**
 * Testes do leitor do arquivo de tarefas: node --test pagina/testes/*.test.mjs
 * Nenhum teste grava em disco.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRASE_VAZIA, SECOES_PADRAO, acrescentarTarefa, categoriaDoModelo, conferir, documentoNovo, marcarEmParte, marcarFeita, moverTarefa,
  paraPagina, parsear, proximoId, resolverTarefas, secoesDoPedido, serializar, tarefasParaConferir,
} from '../md.mjs';

const HOJE = '02/11/2026';

const tarefa = (id, titulo, { situacao = 'Pendente', modelo = true, prompt = true, extra = '' } = {}) => [
  `<a id="${id}"></a>`,
  '',
  `### ${titulo}`,
  '',
  `- **Situação:** ${situacao}`,
  ...(modelo ? ['- **Modelo:** Opus. Motivo.'] : []),
  ...(extra ? ['', extra] : []),
  ...(prompt ? ['', '```text', `Prompt de ${titulo}.`, '```'] : []),
].join('\n');

const EXEMPLO = `# Lista

Cabeçalho do arquivo, com \`## 1. não é seção\` no meio do texto.

## Como usar

Instruções.

## 1. Alta prioridade

> Para fazer primeiro.

${tarefa('t1', 'Primeira')}

${tarefa('t2', 'Segunda', { extra: '**Interpretação:** uma nota.' })}

${tarefa('t3', 'Terceira')}

## 2. Baixa prioridade

> Podem esperar.

Sugestão de ordem.

${tarefa('t4', 'Pequena')}

## 3. Vazia

> Ainda sem nada.

${FRASE_VAZIA}

## 4. Sem prompt

${tarefa('t5', 'Solta')}

${tarefa('t6', 'Gravar o vídeo', { modelo: false, prompt: false })}

## 5. Ideias para o futuro

Sugestões do Claude.

${tarefa('t7', 'Ideia', { situacao: 'Sugestão, aguarda a sua decisão' })}

${tarefa('t8', 'Outra ideia', { situacao: 'Sugestão, aguarda a sua decisão' })}

## 6. Já feitos

> As concluídas.

- Um item antigo, resolvido antes da lista.
`;

const grupo = (doc, id) => doc.grupos.find((g) => g.id === id);
const ids = (g) => g.tarefas.map((t) => t.id);

test('ler e regravar não muda um byte', () => {
  assert.equal(serializar(parsear(EXEMPLO)), EXEMPLO);
});

test('acha as seções, as descrições e as tarefas', () => {
  const doc = parsear(EXEMPLO);
  assert.deepEqual(doc.grupos.map((g) => g.id), ['1', '2', '3', '4', '5', '6']);
  assert.equal(grupo(doc, '1').descricao, 'Para fazer primeiro.');
  assert.equal(grupo(doc, '2').intro, 'Sugestão de ordem.');
  assert.deepEqual(ids(grupo(doc, '4')), ['t5', 't6']);
  assert.equal(grupo(doc, '3').tarefas.length, 0);
  assert.equal(grupo(doc, '3').intro.includes(FRASE_VAZIA), false);
  assert.match(grupo(doc, '6').intro, /item antigo/);
});

test('um arquivo sem seções ou com duas seções iguais é recusado com uma frase clara', () => {
  assert.throws(() => parsear('# Só um título\n'), /seção/);
  assert.throws(() => parsear('## 1. A\n\n## 1. B\n'), /mesmo número/);
});

test('uma linha parecida com seção dentro de um prompt continua no prompt', () => {
  const texto = EXEMPLO.replace('Prompt de Primeira.', '## 9. Não é seção\n<a id="t99"></a>\nFim.');
  const doc = parsear(texto);
  assert.equal(doc.grupos.length, 6);
  assert.equal(serializar(doc), texto);
});

test('a página recebe título, modelo, situação, notas e prompt', () => {
  const pagina = paraPagina(parsear(EXEMPLO), EXEMPLO);
  assert.equal(pagina.feitos, '6');
  const tarefas = pagina.grupos.flatMap((g) => g.tarefas);
  const segunda = tarefas.find((t) => t.id === 't2');
  assert.equal(segunda.titulo, 'Segunda');
  assert.equal(segunda.modeloCat, 'opus');
  assert.equal(segunda.categoria, 'pendente');
  assert.equal(segunda.partes[0].tipo, 'md');
  assert.equal(segunda.partes[1].texto, 'Prompt de Segunda.');
  assert.equal(tarefas.find((t) => t.id === 't7').categoria, 'sugestao');
  assert.equal(tarefas.find((t) => t.id === 't6').modeloCat, 'nenhum');
  assert.equal(pagina.grupos[0].descricao, 'Para fazer primeiro.');
});

test('a categoria do modelo vem do primeiro nome, em qualquer projeto', () => {
  assert.equal(categoriaDoModelo('Opus 5.5. Motivo qualquer.'), 'opus');
  assert.equal(categoriaDoModelo('Fable no plano.'), 'fable');
  assert.equal(categoriaDoModelo('Fable 5.1 no plano e no filtro; Opus 5.5 no resto.'), 'fable');
  assert.equal(categoriaDoModelo('Sonnet'), 'sonnet');
  assert.equal(categoriaDoModelo('A definir.'), 'nenhum');
  assert.equal(categoriaDoModelo('Não se aplica.'), 'nenhum');
  assert.equal(categoriaDoModelo(''), 'nenhum');
});

test('reordenar dentro da seção muda só a ordem', () => {
  const doc = parsear(EXEMPLO);
  assert.equal(moverTarefa(doc, 't3', '1', 't1', HOJE), true);
  const novo = serializar(doc);
  conferir(EXEMPLO, novo);
  assert.deepEqual(ids(grupo(parsear(novo), '1')), ['t3', 't1', 't2']);
});

test('mover para uma seção vazia tira a frase de vazio, e voltar a recoloca', () => {
  const doc = parsear(EXEMPLO);
  moverTarefa(doc, 't2', '3', null, HOJE);
  const novo = serializar(doc);
  conferir(EXEMPLO, novo);
  assert.equal(novo.includes(FRASE_VAZIA), false);
  const relido = parsear(novo);
  assert.deepEqual(ids(grupo(relido, '3')), ['t2']);
  moverTarefa(relido, 't2', '1', 't3', HOJE);
  assert.equal(serializar(relido), EXEMPLO);
});

test('esvaziar uma seção põe a frase de vazio, e o arquivo continua relendo igual', () => {
  const doc = parsear(EXEMPLO);
  moverTarefa(doc, 't4', '3', null, HOJE);
  const novo = serializar(doc);
  assert.equal(grupo(parsear(novo), '2').intro, 'Sugestão de ordem.');
  assert.match(novo, new RegExp(`Sugestão de ordem\\.\n\n${FRASE_VAZIA}`));
  assert.equal(serializar(parsear(novo)), novo);
});

test('levar à última seção marca como feita, e tirar de lá volta à situação de antes', () => {
  const doc = parsear(EXEMPLO);
  moverTarefa(doc, 't7', '6', null, HOJE);
  moverTarefa(doc, 't2', '6', null, HOJE);
  const novo = serializar(doc);
  assert.match(novo, /\*\*Situação:\*\* Feito em 02\/11\/2026 \(marcado na página\)\./);
  const relido = parsear(novo);
  assert.match(grupo(relido, '6').intro, /item antigo/);
  moverTarefa(relido, 't7', '5', 't8', HOJE);
  moverTarefa(relido, 't2', '1', 't3', HOJE);
  assert.equal(serializar(relido), EXEMPLO);
});

test('a anotação de feita em parte sobrevive a ir aos feitos e voltar', () => {
  const parcial = 'Feito em parte em 03/11/2026 (commit abc1234). Feito: o começo. Falta: o resto.';
  const comParte = EXEMPLO.replace('### Primeira\n\n- **Situação:** Pendente', `### Primeira\n\n- **Situação:** ${parcial}`);
  assert.notEqual(comParte, EXEMPLO);
  const doc = parsear(comParte);
  moverTarefa(doc, 't1', '6', null, HOJE);
  const feito = serializar(doc);
  assert.match(feito, /marcado na página\)\. Antes: Feito em parte em 03\/11\/2026/);
  const relido = parsear(feito);
  moverTarefa(relido, 't1', '1', 't2', HOJE);
  assert.equal(serializar(relido), comParte);
});

test('marcar como feita leva a tarefa e guarda o registro', () => {
  const doc = parsear(EXEMPLO);
  assert.equal(marcarFeita(doc, 't1', HOJE, 'commit abc1234; publicado: não'), true);
  const novo = serializar(doc);
  assert.match(novo, /Feito em 02\/11\/2026 \(commit abc1234; publicado: não\)\./);
  assert.deepEqual(ids(grupo(parsear(novo), '6')), ['t1']);
});

test('marcar em parte não muda a tarefa de lugar', () => {
  const doc = parsear(EXEMPLO);
  marcarEmParte(doc, 't2', HOJE, { feito: 'A tela.', falta: 'O PDF.', registro: 'commit abc1234' });
  const novo = serializar(doc);
  assert.match(novo, /Feito em parte em 02\/11\/2026 \(commit abc1234\)\. Feito: A tela\. Falta: O PDF\./);
  assert.deepEqual(ids(grupo(parsear(novo), '1')), ['t1', 't2', 't3']);
});

test('a tarefa sem a linha Situação ganha uma, sem perder o resto', () => {
  const sem = EXEMPLO.replace('### Primeira\n\n- **Situação:** Pendente\n', '### Primeira\n\n');
  const doc = parsear(sem);
  marcarFeita(doc, 't1', HOJE, 'commit abc1234');
  assert.match(serializar(doc), /### Primeira\n\n- \*\*Situação:\*\* Feito em 02\/11\/2026 \(commit abc1234\)\./);
});

test('soltar no mesmo lugar não muda nada, e tarefa ou seção inexistente é recusada', () => {
  const doc = parsear(EXEMPLO);
  assert.equal(moverTarefa(doc, 't1', '1', 't2', HOJE), false);
  assert.equal(moverTarefa(doc, 't1', '1', 't1', HOJE), false);
  assert.throws(() => moverTarefa(doc, 't99', '1', null, HOJE), /tarefa/);
  assert.throws(() => moverTarefa(doc, 't1', '9', null, HOJE), /seção/);
});

test('a trava recusa prompt alterado e tarefa perdida', () => {
  assert.throws(() => conferir(EXEMPLO, EXEMPLO.replace('Prompt de Primeira.', 'Outro texto.')), /prompt/);
  assert.throws(() => conferir(EXEMPLO, EXEMPLO.replace('<a id="t1"></a>\n\n', '')), /tarefa/);
});

test('a tarefa nova entra no fim da seção, no formato das demais, e não muda as outras', () => {
  const doc = parsear(EXEMPLO);
  const id = acrescentarTarefa(doc, {
    titulo: 'Nova', para: '1', prompt: 'Faça isso.\n```\ncódigo\n```', modelo: 'Fable no plano',
    motivoModelo: 'Decisão de arquitetura.', dependeDe: 'Primeira', notas: '**Interpretações:**\n\n- Uma escolha.',
  });
  assert.equal(id, 't9');
  const novo = serializar(doc);
  conferir(EXEMPLO, novo, { novas: 1 });
  assert.throws(() => conferir(EXEMPLO, novo), /prompt|tarefa/);
  assert.match(novo, /^- \*\*Modelo:\*\* Fable no plano\. Decisão de arquitetura\.$/m);
  assert.match(novo, /^- \*\*Depende de:\*\* Primeira$/m);
  // as crases do texto não fecham o bloco, e o arquivo relê igual
  assert.equal(serializar(parsear(novo)), novo);
  const nova = paraPagina(parsear(novo), novo).grupos[0].tarefas.at(-1);
  assert.equal(nova.partes.filter((p) => p.tipo === 'bloco').length, 1);
  assert.match(nova.partes.find((p) => p.tipo === 'bloco').texto, /^ ```$/m);
});

test('o id da tarefa nova não colide, mesmo com ids antigos no formato t1-4', () => {
  const doc = parsear(EXEMPLO);
  assert.equal(proximoId(doc), 't9');
  moverTarefa(doc, 't3', '5', null, HOJE);
  assert.equal(proximoId(doc), 't9');
  const antigo = parsear(EXEMPLO.replace('<a id="t1"></a>', '<a id="t2-30"></a>'));
  assert.equal(proximoId(antigo), 't31');
});

test('a tarefa nova segue a seção: sugestão nas ideias, e não entra nos feitos', () => {
  const doc = parsear(EXEMPLO);
  acrescentarTarefa(doc, { titulo: 'Ideia nova', para: '5', prompt: 'Texto.', modelo: 'Opus' });
  acrescentarTarefa(doc, { titulo: 'Tarefa solta', para: 4, prompt: '' });
  const novo = serializar(doc);
  assert.match(novo, /### Ideia nova\n\n- \*\*Situação:\*\* Sugestão, aguarda a sua decisão/);
  assert.match(novo, /### Tarefa solta\n\n- \*\*Situação:\*\* Pendente\n- \*\*Modelo:\*\* A definir\.$/m);
  assert.throws(() => acrescentarTarefa(doc, { titulo: 'X', para: '6' }), /Já feitos/);
  assert.throws(() => acrescentarTarefa(doc, { titulo: '  ', para: '1' }), /título/);
});

test('resolver leva as feitas à última seção e deixa as em parte onde estão', () => {
  const doc = parsear(EXEMPLO);
  resolverTarefas(doc, {
    feitas: [{ id: 't1', evidencia: 'Em shared/x.ts.' }, { id: 't4' }],
    parciais: [{ id: 't2', feito: 'A tela.', falta: 'O PDF.' }],
  }, HOJE);
  const novo = serializar(doc);
  conferir(EXEMPLO, novo);
  const relido = parsear(novo);
  assert.deepEqual(ids(grupo(relido, '6')), ['t1', 't4']);
  assert.ok(ids(grupo(relido, '1')).includes('t2'));
  assert.match(novo, /Feito em 02\/11\/2026 \(conferido pelo Claude na página\. Evidência: Em shared\/x\.ts\.\)\./);
  assert.match(novo, /Feito em parte em 02\/11\/2026 \(conferido pelo Claude na página\)\. Feito: A tela\. Falta: O PDF\./);
});

test('a tarefa já registrada como feita muda de lugar sem perder o registro', () => {
  const registro = 'Feito em 03/11/2026 (commit abc1234; publicado: não).';
  const comRegistro = EXEMPLO.replace('### Primeira\n\n- **Situação:** Pendente', `### Primeira\n\n- **Situação:** ${registro}`);
  const doc = parsear(comRegistro);
  resolverTarefas(doc, { feitas: [{ id: 't1' }] }, HOJE);
  assert.ok(serializar(doc).includes(`- **Situação:** ${registro}`));
});

test('a conferência leva só as tarefas abertas com prompt, em qualquer seção', () => {
  const doc = parsear(EXEMPLO);
  resolverTarefas(doc, { feitas: [{ id: 't1' }] }, HOJE);
  const lista = tarefasParaConferir(doc).map((t) => t.id);
  assert.equal(lista.includes('t1'), false);
  assert.equal(lista.includes('t6'), false);
  assert.ok(lista.includes('t5'));
  assert.ok(lista.includes('t7'));
  assert.deepEqual(tarefasParaConferir(doc, ['t2']).map((t) => t.id), ['t2']);
  assert.equal(tarefasParaConferir(doc, ['t2'])[0].prompt, 'Prompt de Segunda.');
});

test('o arquivo de um projeto novo relê igual, com as seções padrão', () => {
  const texto = documentoNovo({ projeto: 'Meu projeto', arquivo: '/p/.tarefas/tarefas.md', comando: 'node "/s/servidor.mjs"' });
  const doc = parsear(texto);
  assert.equal(serializar(doc), texto);
  assert.equal(doc.grupos.length, SECOES_PADRAO.length);
  assert.equal(doc.grupos.at(-1).nome, 'Já feitos');
  assert.match(texto, /Não siga este documento sem um pedido/);
  assert.match(texto, /node "\/s\/servidor\.mjs" feito t12/);
  assert.equal(texto.split(FRASE_VAZIA).length - 1, SECOES_PADRAO.length - 1);
});

test('as seções pedidas sempre terminam na dos feitos', () => {
  assert.deepEqual(secoesDoPedido('Bugs|Melhorias').map((s) => s[0]), ['Bugs', 'Melhorias', 'Já feitos']);
  assert.deepEqual(secoesDoPedido('Bugs|Concluídas').map((s) => s[0]), ['Bugs', 'Concluídas']);
  assert.deepEqual(secoesDoPedido('Bugs|Prontas').map((s) => s[0]), ['Bugs', 'Prontas']);
  assert.equal(secoesDoPedido(undefined), SECOES_PADRAO);
  const texto = documentoNovo({ projeto: 'P', arquivo: '/a', comando: 'c', secoes: secoesDoPedido('Bugs|Melhorias') });
  assert.equal(serializar(parsear(texto)), texto);
  assert.equal(paraPagina(parsear(texto), texto).feitos, '3');
});
