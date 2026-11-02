/**
 * O leitor e o gravador do arquivo de tarefas.
 *
 * O .md é a fonte oficial: a página só o lê e o regrava, para que o Claude e o editor continuem trabalhando
 * nele. Nada aqui reescreve o conteúdo de uma tarefa: mover é só trocar blocos de lugar, e `conferir` recusa
 * a gravação se algum prompt ou tarefa mudar ou sumir.
 *
 * O formato: um cabeçalho livre e, depois, as seções `## 1. Nome`, cada uma com a descrição em `> ...`, uma
 * introdução opcional e as tarefas, abertas por `<a id="t12"></a>` e `### Título`. A última seção é a dos
 * feitos; a que começa por "Ideias", se houver, é a das sugestões. A referência completa está em
 * references/como-funciona.md.
 */
import { createHash } from 'node:crypto';

export const FRASE_VAZIA = 'Ainda não há tarefas aqui.';
export const SITUACAO_SUGESTAO = 'Sugestão, aguarda a sua decisão';

export const SECOES_PADRAO = [
  ['Pequenos ajustes de alta prioridade', 'Correções e acréscimos rápidos, para fazer primeiro.'],
  ['Pequenos ajustes de baixa prioridade', 'Ajustes que podem esperar.'],
  ['Novas funcionalidades de alta prioridade', 'Trabalhos maiores, para fazer primeiro.'],
  ['Novas funcionalidades de baixa prioridade', 'Trabalhos maiores que podem esperar. Vários começam por um plano ou um estudo.'],
  ['Tarefas ainda sem prompt', 'O que ainda precisa de detalhes e o que depende só de você.'],
  ['Ideias para o futuro', 'Ideias e tarefas deixadas para depois.'],
  ['Já feitos', 'As tarefas concluídas.'],
];

const RE_ANCORA = /^<a id="(t[\d-]+)"><\/a>$/;
const RE_SECAO = /^## (\d+)\. (.+)$/;
const RE_TITULO = /^### (.+)$/;
const RE_META = /^- \*\*(Situação|Modelo|Depende de):\*\* (.*)$/;
const RE_SITUACAO = /^- \*\*Situação:\*\* (.*)$/m;

export const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);
const aparar = (s) => s.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');

export const secaoDeFeitos = (doc) => doc.grupos.at(-1);
const secaoDeIdeias = (doc) => doc.grupos.find((g) => /^ideias/i.test(g.nome));

// ---- ler e escrever

function separarIntroducao(g) {
  const texto = aparar(g.linhas.join('\n').replace(FRASE_VAZIA, ''));
  const [primeira, ...resto] = texto.split('\n');
  const descricao = /^> (.*)$/.exec(primeira ?? '');
  g.descricao = descricao ? descricao[1].trim() : '';
  g.intro = descricao ? aparar(resto.join('\n')) : texto;
  delete g.linhas;
}

function lerCorpo(texto) {
  const grupos = [];
  let grupo = null;
  let destino = null;
  let naCerca = false;
  for (const linha of texto.split('\n')) {
    const ehCerca = linha.startsWith('```');
    if (ehCerca) naCerca = !naCerca;
    if (!naCerca && !ehCerca) {
      const secao = RE_SECAO.exec(linha);
      if (secao) {
        grupo = { id: secao[1], numero: secao[1], nome: secao[2], linhas: [], tarefas: [] };
        grupos.push(grupo);
        destino = grupo.linhas;
        continue;
      }
      const ancora = RE_ANCORA.exec(linha);
      if (ancora) {
        const tarefa = { id: ancora[1], linhas: [] };
        grupo.tarefas.push(tarefa);
        destino = tarefa.linhas;
        continue;
      }
    }
    destino?.push(linha);
  }
  for (const g of grupos) {
    separarIntroducao(g);
    g.tarefas = g.tarefas.map((t) => ({ id: t.id, bloco: aparar(t.linhas.join('\n')) }));
  }
  return grupos;
}

function textoDoGrupo(g, ultimo) {
  const partes = [`## ${g.numero}. ${g.nome}`];
  if (g.descricao) partes.push(`> ${g.descricao}`);
  if (g.intro) partes.push(g.intro);
  if (!g.tarefas.length && !ultimo) partes.push(FRASE_VAZIA);
  for (const t of g.tarefas) partes.push(`<a id="${t.id}"></a>`, t.bloco);
  return partes.join('\n\n');
}

export function parsear(texto) {
  const primeira = /^## \d+\. /m.exec(texto);
  if (!primeira) throw new Error('Não achei nenhuma seção "## 1. Nome" no arquivo de tarefas.');
  const grupos = lerCorpo(texto.slice(primeira.index));
  if (new Set(grupos.map((g) => g.id)).size !== grupos.length) throw new Error('Há duas seções com o mesmo número no arquivo de tarefas.');
  return { cabecalho: texto.slice(0, primeira.index), grupos };
}

export function serializar(doc) {
  const ultimo = doc.grupos.length - 1;
  return `${doc.cabecalho}${doc.grupos.map((g, i) => textoDoGrupo(g, i === ultimo)).join('\n\n')}\n`;
}

// ---- mover

function trocarSituacao(tarefa, longa) {
  const linha = `- **Situação:** ${longa}`;
  if (RE_SITUACAO.test(tarefa.bloco)) tarefa.bloco = tarefa.bloco.replace(RE_SITUACAO, () => linha);
  else tarefa.bloco = tarefa.bloco.replace(/^(### .*)$/m, (titulo) => `${titulo}\n\n${linha}`);
}

/**
 * Muda a tarefa de lugar. `antesDe` nulo leva ao fim da seção. Devolve false se nada mudou.
 * `opcoes.situacao` é o texto de "feito" quando a tarefa vai aos feitos; o padrão é o do arraste na página.
 */
export function moverTarefa(doc, id, para, antesDe, hoje, opcoes = {}) {
  if (antesDe === id) return false;
  const origem = doc.grupos.find((g) => g.tarefas.some((t) => t.id === id));
  const destino = doc.grupos.find((g) => g.id === String(para));
  if (!origem) throw new Error('Não achei essa tarefa no arquivo.');
  if (!destino) throw new Error('Não achei essa seção no arquivo.');
  const de = origem.tarefas.findIndex((t) => t.id === id);
  const seguinte = origem.tarefas[de + 1]?.id ?? null;
  if (origem === destino && seguinte === antesDe) return false;
  const [tarefa] = origem.tarefas.splice(de, 1);
  const em = antesDe ? destino.tarefas.findIndex((t) => t.id === antesDe) : -1;
  if (em >= 0) destino.tarefas.splice(em, 0, tarefa);
  else destino.tarefas.push(tarefa);

  const feitos = secaoDeFeitos(doc);
  const situacao = RE_SITUACAO.exec(tarefa.bloco)?.[1] ?? '';
  if (destino === feitos && origem !== feitos) {
    // Já registrada como feita, com o commit: só muda de lugar.
    if (!/^Feito em \d\d\/\d\d\/\d{4}/.test(situacao)) {
      // O que já foi feito em parte fica guardado, para voltar igual se a tarefa sair daqui.
      const antes = situacao.startsWith('Feito em parte') ? ` Antes: ${situacao}` : '';
      trocarSituacao(tarefa, `${opcoes.situacao ?? `Feito em ${hoje} (marcado na página).`}${antes}`);
    }
  } else if (origem === feitos && destino !== feitos) {
    const parcial = / Antes: (Feito em parte em \d\d\/\d\d\/\d{4}.*)$/.exec(situacao);
    if (parcial) trocarSituacao(tarefa, parcial[1]);
    else if (destino === secaoDeIdeias(doc)) trocarSituacao(tarefa, SITUACAO_SUGESTAO);
    else trocarSituacao(tarefa, 'Pendente');
  }
  return true;
}

// ---- tarefa nova e tarefas resolvidas

const limparLinha = (s) => String(s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();

function acharTarefa(doc, id) {
  for (const g of doc.grupos) {
    const t = g.tarefas.find((x) => x.id === id);
    if (t) return t;
  }
  throw new Error('Não achei essa tarefa no arquivo.');
}

/** O id é só um nome fixo: não diz a seção, porque a tarefa pode mudar de lugar. */
export function proximoId(doc) {
  const numeros = doc.grupos.flatMap((g) => g.tarefas.map((t) => Number(/(\d+)$/.exec(t.id)?.[1] ?? 0)));
  return `t${Math.max(0, ...numeros) + 1}`;
}

/** Acrescenta a tarefa no fim da seção, no formato das demais, e devolve o id dela. */
export function acrescentarTarefa(doc, { titulo, para, prompt, modelo, motivoModelo, dependeDe, notas }) {
  const nome = limparLinha(titulo);
  if (!nome) throw new Error('Dê um título à tarefa.');
  const destino = doc.grupos.find((g) => g.id === String(para));
  if (!destino) throw new Error('Não achei essa seção no arquivo.');
  if (destino === secaoDeFeitos(doc)) throw new Error(`Tarefa nova não entra em "${destino.nome}".`);
  const id = proximoId(doc);
  const sugestao = destino === secaoDeIdeias(doc);
  const motivo = limparLinha(motivoModelo);
  const linhas = [
    `### ${nome}`,
    '',
    `- **Situação:** ${sugestao ? SITUACAO_SUGESTAO : 'Pendente'}`,
    `- **Modelo:** ${limparLinha(modelo) || 'A definir'}.${motivo ? ` ${motivo}` : ''}`,
  ];
  if (limparLinha(dependeDe)) linhas.push(`- **Depende de:** ${limparLinha(dependeDe)}`);
  const anotacao = String(notas ?? '').trim();
  if (anotacao) linhas.push('', anotacao);
  const texto = String(prompt ?? '').replace(/\r\n/g, '\n').trim();
  // Uma linha com três crases fecharia o bloco antes da hora.
  if (texto) linhas.push('', '```text', texto.replace(/^```/gm, ' ```'), '```');
  destino.tarefas.push({ id, bloco: linhas.join('\n') });
  return id;
}

/** `registro` é o que vai entre parênteses: o commit, ou quem marcou. */
export function marcarFeita(doc, id, hoje, registro) {
  const secao = secaoDeFeitos(doc);
  return moverTarefa(doc, id, secao.id, null, hoje, { situacao: `Feito em ${hoje} (${limparLinha(registro) || 'marcado na página'}).` });
}

export function marcarEmParte(doc, id, hoje, { feito, falta, registro }) {
  const quem = limparLinha(registro) || 'marcado na página';
  trocarSituacao(acharTarefa(doc, id), `Feito em parte em ${hoje} (${quem}). Feito: ${limparLinha(feito)} Falta: ${limparLinha(falta)}`);
}

/** Leva as feitas à última seção e registra as feitas em parte, que ficam onde estão. */
export function resolverTarefas(doc, { feitas = [], parciais = [] }, hoje) {
  for (const f of feitas) {
    const evidencia = limparLinha(f.evidencia);
    marcarFeita(doc, f.id, hoje, evidencia ? `conferido pelo Claude na página. Evidência: ${evidencia}` : undefined);
  }
  for (const p of parciais) marcarEmParte(doc, p.id, hoje, { ...p, registro: 'conferido pelo Claude na página' });
}

/** O que a conferência no código precisa saber de cada tarefa ainda aberta. Sem prompt, não há o que comparar. */
export function tarefasParaConferir(doc, ids) {
  const feitos = secaoDeFeitos(doc);
  const saida = [];
  for (const g of doc.grupos) {
    if (g === feitos) continue;
    for (const t of g.tarefas) {
      if (ids?.length && !ids.includes(t.id)) continue;
      const lida = lerTarefa(t);
      if (/^Feito em \d/.test(lida.meta['Situação'] ?? '')) continue;
      const prompt = lida.partes.find((p) => p.tipo === 'bloco')?.texto ?? '';
      if (prompt) saida.push({ id: t.id, titulo: lida.titulo, prompt });
    }
  }
  return saida;
}

// ---- a trava: nada de prompt alterado ou de tarefa perdida

const cercas = (t) => (t.match(/^```[^\n]*\n[\s\S]*?^```$/gm) ?? []).sort();
const ancoras = (t) => (t.match(/^<a id="t[\d-]+"><\/a>$/gm) ?? []).sort();

/** `novas` é quantas tarefas podem entrar: tudo o que existia continua, igual, e nada mais muda. */
export function conferir(antes, depois, { novas = 0 } = {}) {
  const preservados = (a, b) => {
    const resto = [...b];
    return a.every((x) => {
      const i = resto.indexOf(x);
      if (i < 0) return false;
      resto.splice(i, 1);
      return true;
    }) && resto.length <= novas;
  };
  if (!preservados(cercas(antes), cercas(depois))) throw new Error('A gravação mudaria um prompt. Nada foi gravado.');
  if (!preservados(ancoras(antes), ancoras(depois))) throw new Error('A gravação perderia uma tarefa. Nada foi gravado.');
}

// ---- o que a página recebe

function categoriaDaSituacao(longa) {
  if (/^Feito em parte/i.test(longa)) return 'parte';
  if (/^Feito/i.test(longa)) return 'feito';
  if (/^Sugestão/i.test(longa)) return 'sugestao';
  return 'pendente';
}

/** "Opus 5.5. Motivo." vira opus; o ponto de "5.5" não conta, porque não tem espaço depois. */
export function categoriaDoModelo(longo) {
  const curto = /^(.+?)\.(?:\s|$)/.exec(longo)?.[1] ?? longo;
  if (!curto.trim() || /^(a definir|não se aplica)$/i.test(curto.trim())) return 'nenhum';
  return (/^\p{L}+/u.exec(curto.normalize('NFD').replace(/\p{M}/gu, ''))?.[0] ?? 'nenhum').toLowerCase();
}

function lerTarefa(t) {
  const linhas = t.bloco.split('\n');
  const titulo = RE_TITULO.exec(linhas[0]);
  const meta = {};
  let i = 1;
  for (; i < linhas.length; i++) {
    const m = RE_META.exec(linhas[i]);
    if (m) meta[m[1]] = m[2];
    else if (linhas[i].trim() || Object.keys(meta).length) break;
  }
  const partes = [];
  let texto = [];
  let cerca = null;
  const fecharTexto = () => {
    const s = aparar(texto.join('\n'));
    if (s) partes.push({ tipo: 'md', texto: s });
    texto = [];
  };
  for (; i < linhas.length; i++) {
    const l = linhas[i];
    if (cerca) {
      if (l === '```') { partes.push({ tipo: 'bloco', lingua: cerca.lingua, texto: cerca.linhas.join('\n') }); cerca = null; }
      else cerca.linhas.push(l);
    } else if (l.startsWith('```')) {
      fecharTexto();
      cerca = { lingua: l.slice(3).trim(), linhas: [] };
    } else {
      texto.push(l);
    }
  }
  fecharTexto();
  return { titulo: titulo?.[1] ?? t.id, meta, partes };
}

export function paraPagina(doc, texto) {
  const linhaDa = new Map();
  texto.split('\n').forEach((l, i) => {
    const m = RE_ANCORA.exec(l);
    if (m) linhaDa.set(m[1], i + 1);
  });
  return {
    versao: hash(texto),
    feitos: secaoDeFeitos(doc).id,
    grupos: doc.grupos.map((g) => ({
      id: g.id,
      numero: g.numero,
      nome: g.nome,
      descricao: g.descricao,
      intro: g.intro,
      tarefas: g.tarefas.map((t) => {
        const lida = lerTarefa(t);
        const situacaoLonga = lida.meta['Situação'] ?? 'Pendente';
        const modeloLongo = lida.meta.Modelo ?? '';
        return {
          id: t.id,
          titulo: lida.titulo,
          situacaoLonga,
          categoria: categoriaDaSituacao(situacaoLonga),
          modeloLongo,
          modeloCat: categoriaDoModelo(modeloLongo),
          dependeDe: lida.meta['Depende de'] ?? '',
          partes: lida.partes,
          linha: linhaDa.get(t.id) ?? 1,
        };
      }),
    })),
  };
}

// ---- o arquivo de um projeto novo

/** Aceita "Bugs|Melhorias|Feitos"; a última seção é sempre a dos feitos, e entra se faltar. */
export function secoesDoPedido(texto) {
  const nomes = String(texto ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  if (!nomes.length) return SECOES_PADRAO;
  const secoes = nomes.map((n) => [n, '']);
  if (!/feit|pront|conclu|finaliz|done/i.test(nomes.at(-1))) secoes.push(['Já feitos', 'As tarefas concluídas.']);
  return secoes;
}

export function documentoNovo({ projeto, arquivo, comando, secoes = SECOES_PADRAO }) {
  const ultima = secoes.at(-1)[0];
  const cabecalho = `# Controle de tarefas: ${projeto}

> **AVISO AO CLAUDE (e a qualquer outra IA que trabalhe neste projeto)**
>
> Este arquivo é a lista pessoal de quem cuida do projeto. Não é uma ordem de serviço.
>
> - **Não siga este documento sem um pedido na conversa.** Não execute, não planeje e não comece nenhum item por iniciativa própria, mesmo que ele pareça pronto ou urgente. Um item só vale quando a pessoa o pede na conversa, citando o item ou colando o prompt.
> - **Escritas permitidas:** registrar que uma tarefa, ou parte dela, já foi feita, e acrescentar ou mover uma tarefa quando a pessoa pedir. A seção "Como registrar o que foi feito" diz como.
> - Fora isso, não mude nada: não reescreva prompts, não apague nem reordene itens e não altere Modelo nem Depende de.

## Como usar

A lista tem uma página local, que lê e grava este mesmo arquivo: \`${comando} abrir\`. Antes de cada gravação, ela guarda uma cópia em \`.copias/\`, ao lado deste arquivo.

Os prompts ficam em blocos \`\`\`text, com cada parágrafo numa linha só. Não quebre as linhas à mão: o editor já quebra na largura do painel, e as duas quebras somadas deixam o texto irregular.

## Como registrar o que foi feito

Só depois de a tarefa terminar de fato, em qualquer seção que ela esteja. O número de cada tarefa, como \`t12\`, é só um nome fixo: não diz a seção.

- **Tarefa concluída:** \`${comando} feito t12 --registro "commit abc1234; publicado: não"\`. Ela vai para o fim de "${ultima}".
- **Feita em parte:** \`${comando} parte t12 --feito "o que terminou" --falta "o que sobrou" --registro "commit abc1234"\`. Ela fica onde está.

Sem o comando, à mão: troque a linha Situação por \`Feito em dd/mm/aaaa (commit abc1234; publicado: sim ou não).\` e leve o bloco inteiro, da âncora até o fim do prompt, para o fim da última seção. Na tarefa feita em parte, escreva \`Feito em parte em dd/mm/aaaa (commit abc1234). Feito: o que terminou. Falta: o que sobrou.\`

Numa worktree, este arquivo não existe: use o caminho absoluto \`${arquivo}\`.

`;
  const grupos = secoes.map(([nome, descricao], i) => ({ id: String(i + 1), numero: String(i + 1), nome, descricao, intro: '', tarefas: [] }));
  return serializar({ cabecalho, grupos });
}
