/**
 * A tela da lista. Tudo o que muda a ordem vai ao servidor, que grava no .md; o resto (o que está aberto,
 * os filtros) fica só neste navegador. A página relê o arquivo sozinha quando ele muda por fora, porque o
 * Claude também escreve nele.
 */
import { abrirConferencia, abrirNovaTarefa, abrirTrabalho, iniciarJanelas } from './janelas.js';

const CHAVE = 'controle-de-tarefas-v1';
const INTERVALO_RELEITURA = 3000;
const LINHAS_DO_PROMPT_RECOLHIDO = 9;

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const ROTULO_SITUACAO = { sugestao: 'Sugestão', parte: 'Em parte', feito: 'Feita' };
const ICONE_COPIAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.25A1.25 1.25 0 0 1 2 9.25v-6A1.25 1.25 0 0 1 3.25 2h6a1.25 1.25 0 0 1 1.25 1.25v.25"/></svg>';
const ICONE_ALCA = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>';

const estado = {
  doc: null,
  gruposFechados: new Set(),
  tarefasAbertas: new Set(),
  promptsAbertos: new Set(),
  busca: '',
  modelo: 'todos',
  situacao: 'todas',
  ocupado: false,
};
let arrastando = null;

// ---- o que fica guardado neste navegador

function carregarPreferencias() {
  try {
    const p = JSON.parse(localStorage.getItem(CHAVE) ?? '{}');
    estado.gruposFechados = new Set(p.gruposFechados ?? []);
    estado.tarefasAbertas = new Set(p.tarefasAbertas ?? []);
    estado.promptsAbertos = new Set(p.promptsAbertos ?? []);
    estado.modelo = p.modelo ?? 'todos';
    estado.situacao = p.situacao ?? 'todas';
  } catch { /* sem armazenamento, a página começa do zero */ }
}

function guardarPreferencias() {
  try {
    localStorage.setItem(CHAVE, JSON.stringify({
      gruposFechados: [...estado.gruposFechados],
      tarefasAbertas: [...estado.tarefasAbertas],
      promptsAbertos: [...estado.promptsAbertos],
      modelo: estado.modelo,
      situacao: estado.situacao,
    }));
  } catch { /* só uma conveniência */ }
}

// ---- um Markdown mínimo, para as notas: tudo é escapado antes

function emLinha(texto) {
  return esc(texto)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function celulas(linha) {
  return linha.replace(/^\|\s?/, '').replace(/\s?\|$/, '').split(' | ');
}

function markdown(texto) {
  const linhas = texto.split('\n');
  const saida = [];
  for (let i = 0; i < linhas.length;) {
    const l = linhas[i];
    if (!l.trim()) { i += 1; continue; }
    if (l.startsWith('| ') && /^\|[-| ]+\|$/.test(linhas[i + 1] ?? '')) {
      const topo = celulas(l).map((c) => `<th scope="col">${emLinha(c)}</th>`).join('');
      i += 2;
      const corpo = [];
      while (linhas[i]?.startsWith('| ')) { corpo.push(`<tr>${celulas(linhas[i]).map((c) => `<td>${emLinha(c)}</td>`).join('')}</tr>`); i += 1; }
      saida.push(`<div class="rolagem"><table><thead><tr>${topo}</tr></thead><tbody>${corpo.join('')}</tbody></table></div>`);
      continue;
    }
    if (/^(?:-|\d+\.) /.test(l)) {
      const ordenada = /^\d/.test(l);
      const itens = [];
      while (linhas[i] && /^(?:-|\d+\.) /.test(linhas[i])) { itens.push(`<li>${emLinha(linhas[i].replace(/^(?:-|\d+\.) /, ''))}</li>`); i += 1; }
      saida.push(ordenada ? `<ol>${itens.join('')}</ol>` : `<ul>${itens.join('')}</ul>`);
      continue;
    }
    const paragrafo = [];
    while (linhas[i]?.trim() && !/^(?:- |\d+\. |\| )/.test(linhas[i])) { paragrafo.push(linhas[i]); i += 1; }
    saida.push(`<p>${emLinha(paragrafo.join(' '))}</p>`);
  }
  return saida.join('');
}

// ---- filtros

const textoDaTarefa = (t) => semAcento([t.titulo, t.situacaoLonga, t.modeloLongo, t.dependeDe, ...t.partes.map((p) => p.texto)].join(' '));
const haFiltro = () => Boolean(estado.busca) || estado.modelo !== 'todos' || estado.situacao !== 'todas';

function passaNoFiltro(t) {
  if (estado.modelo !== 'todos' && t.modeloCat !== estado.modelo) return false;
  if (estado.situacao !== 'todas' && t.categoria !== estado.situacao) return false;
  if (estado.busca && !estado.busca.split(/\s+/).every((p) => textoDaTarefa(t).includes(p))) return false;
  return true;
}

// ---- desenho

const nomeDoModelo = (categoria) => categoria[0].toUpperCase() + categoria.slice(1);

/** Os modelos do filtro são os que aparecem na lista, porque cada projeto escolhe os seus. */
function desenharFiltroDeModelos() {
  const categorias = [...new Set(estado.doc.grupos.flatMap((g) => g.tarefas.map((t) => t.modeloCat)))].filter((c) => c !== 'nenhum').sort();
  if (estado.modelo !== 'todos' && !categorias.includes(estado.modelo)) categorias.push(estado.modelo);
  $('#f-modelo').innerHTML = [['todos', 'Todos os modelos'], ...categorias.map((c) => [c, nomeDoModelo(c)])]
    .map(([valor, nome]) => `<option value="${esc(valor)}"${valor === estado.modelo ? ' selected' : ''}>${esc(nome)}</option>`).join('');
}

function chips(t) {
  const c = [];
  if (ROTULO_SITUACAO[t.categoria]) c.push(`<span class="chip chip-${t.categoria}">${ROTULO_SITUACAO[t.categoria]}</span>`);
  if (t.dependeDe) c.push(`<span class="chip chip-depende" title="Depende de: ${esc(t.dependeDe)}">Depende</span>`);
  if (t.modeloCat !== 'nenhum') c.push(`<span class="chip chip-${esc(t.modeloCat)}" title="${esc(t.modeloLongo)}">${esc(nomeDoModelo(t.modeloCat))}</span>`);
  return c.join('');
}

function blocoDeTexto(t, parte, indice) {
  const chave = `${t.id}:${indice}`;
  const longo = parte.texto.split('\n').length > LINHAS_DO_PROMPT_RECOLHIDO || parte.texto.length > 900;
  const aberto = !longo || estado.promptsAbertos.has(chave);
  const nome = parte.lingua === 'bash' ? 'Comando' : 'Prompt';
  return `<figure class="prompt${aberto ? '' : ' recolhido'}">
    <figcaption>
      <span>${nome}</span>
      <span class="prompt-acoes">
        ${longo ? `<button type="button" class="botao-leve" data-acao="prompt" data-chave="${esc(chave)}" aria-expanded="${aberto}">${aberto ? 'Recolher' : 'Expandir'}</button>` : ''}
        <button type="button" class="botao-leve" data-acao="copiar" data-indice="${indice}">${ICONE_COPIAR}<span>Copiar</span></button>
      </span>
    </figcaption>
    <pre tabindex="0"><code>${esc(parte.texto)}</code></pre>
  </figure>`;
}

function corpoDaTarefa(t, grupo) {
  const opcoes = estado.doc.grupos
    .map((g) => `<option value="${g.id}"${g.id === grupo.id ? ' selected' : ''}>${esc(nomeDoGrupo(g))}</option>`)
    .join('');
  const meta = [`<div><dt>Situação</dt><dd>${emLinha(t.situacaoLonga)}</dd></div>`];
  if (t.modeloLongo) meta.push(`<div><dt>Modelo</dt><dd>${emLinha(t.modeloLongo)}</dd></div>`);
  if (t.dependeDe) meta.push(`<div><dt>Depende de</dt><dd>${emLinha(t.dependeDe)}</dd></div>`);
  const partes = t.partes.map((p, i) => (p.tipo === 'md' ? `<div class="texto">${markdown(p.texto)}</div>` : blocoDeTexto(t, p, i))).join('');
  const caminho = encodeURI(`vscode://file${estado.doc.arquivo}:${t.linha}`);
  return `<div class="tarefa-corpo" id="corpo-${t.id}">
    <dl class="meta">${meta.join('')}</dl>
    ${partes}
    <div class="tarefa-acoes">
      <label>Mover para
        <select data-acao="mover-para" aria-label="Mover ${esc(t.titulo)} para outra seção">${opcoes}</select>
      </label>
      <button type="button" class="botao-leve" data-acao="subir">Subir</button>
      <button type="button" class="botao-leve" data-acao="descer">Descer</button>
      <a class="botao-leve" href="${esc(caminho)}">Abrir no arquivo</a>
    </div>
  </div>`;
}

function htmlDaTarefa(t, grupo) {
  const aberta = estado.tarefasAbertas.has(t.id);
  const primeiro = t.partes.findIndex((p) => p.tipo === 'bloco');
  return `<li class="tarefa${aberta ? ' aberta' : ''}" data-id="${t.id}" draggable="true">
    <div class="linha">
      <span class="alca" title="Arraste para mudar a ordem ou a seção">${ICONE_ALCA}</span>
      <button type="button" class="abrir" data-acao="tarefa" aria-expanded="${aberta}" aria-controls="corpo-${t.id}">
        <span class="seta" aria-hidden="true"></span>
        <span class="titulo">${esc(t.titulo)}</span>
      </button>
      <span class="chips">${chips(t)}</span>
      ${primeiro >= 0 ? `<button type="button" class="copiar" data-acao="copiar" data-indice="${primeiro}" aria-label="Copiar: ${esc(t.titulo)}">${ICONE_COPIAR}<span>Copiar</span></button>` : '<span class="copiar-vazio"></span>'}
    </div>
    ${aberta ? corpoDaTarefa(t, grupo) : ''}
  </li>`;
}

const nomeDoGrupo = (g) => `${g.numero}. ${g.nome}`;

function htmlDoGrupo(g) {
  const visiveis = g.tarefas.filter(passaNoFiltro);
  if (haFiltro() && !visiveis.length) return '';
  const fechado = !estado.busca && estado.gruposFechados.has(g.id);
  const contagem = visiveis.length === g.tarefas.length ? `${g.tarefas.length}` : `${visiveis.length} de ${g.tarefas.length}`;
  const conteudo = [];
  if (!fechado) {
    if (g.intro && !haFiltro()) conteudo.push(`<div class="texto grupo-intro">${markdown(g.intro)}</div>`);
    if (visiveis.length) conteudo.push(`<ol class="tarefas">${visiveis.map((t) => htmlDaTarefa(t, g)).join('')}</ol>`);
    else conteudo.push('<p class="vazio">Arraste uma tarefa para cá.</p>');
  }
  return `<section class="grupo${fechado ? ' fechado' : ''}" id="g-${g.id}" data-grupo="${g.id}">
    <h2>
      <button type="button" class="grupo-cabecalho" data-acao="grupo" aria-expanded="${!fechado}">
        <span class="seta" aria-hidden="true"></span>
        <span class="grupo-nome">${esc(nomeDoGrupo(g))}</span>
        <span class="contagem">${contagem}</span>
        <span class="grupo-descricao">${esc(g.descricao)}</span>
      </button>
    </h2>
    ${conteudo.join('')}
  </section>`;
}

function desenharLateral() {
  $('#lateral').innerHTML = `<ul>${estado.doc.grupos.map((g) => {
    const n = g.tarefas.filter(passaNoFiltro).length;
    return `<li><a href="#g-${g.id}" class="lateral-item" data-grupo="${g.id}" data-acao="ir-grupo">
      <span>${esc(nomeDoGrupo(g))}</span><span class="contagem">${n}</span></a></li>`;
  }).join('')}</ul>`;
}

function desenharResumo() {
  const todas = estado.doc.grupos.flatMap((g) => g.tarefas);
  const conta = (c) => todas.filter((t) => t.categoria === c).length;
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const partes = [plural(todas.length, 'tarefa', 'tarefas'), plural(conta('pendente'), 'pendente', 'pendentes'), plural(conta('sugestao'), 'sugestão', 'sugestões')];
  if (conta('parte')) partes.push(`${conta('parte')} em parte`);
  partes.push(plural(conta('feito'), 'feita', 'feitas'));
  if (haFiltro()) partes.push(`${todas.filter(passaNoFiltro).length} no filtro`);
  $('#resumo').textContent = partes.join(' · ');
}

function desenhar() {
  const foco = document.activeElement?.closest?.('[data-acao]');
  const chaveFoco = foco ? [foco.closest('[data-id]')?.dataset.id, foco.closest('[data-grupo]')?.dataset.grupo, foco.dataset.acao] : null;
  const html = estado.doc.grupos.map(htmlDoGrupo).join('');
  $('#lista').innerHTML = html || '<p class="vazio-geral">Nenhuma tarefa com esse filtro.</p>';
  $('#lista').setAttribute('aria-busy', 'false');
  desenharLateral();
  desenharResumo();
  if (chaveFoco && foco.closest('#lista')) {
    const [id, grupo, acao] = chaveFoco;
    const raiz = id ? $(`[data-id="${id}"]`) : $(`#lista [data-grupo="${grupo}"]`);
    $(`[data-acao="${acao}"]`, raiz ?? document)?.focus({ preventScroll: true });
  }
}

// ---- avisos

function avisar(mensagem, opcoes = {}) {
  const caixa = document.createElement('div');
  caixa.className = `aviso${opcoes.erro ? ' aviso-erro' : ''}`;
  caixa.textContent = mensagem;
  if (opcoes.desfazer) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Desfazer';
    b.addEventListener('click', () => { caixa.remove(); opcoes.desfazer(); });
    caixa.append(b);
  }
  $('#avisos').append(caixa);
  setTimeout(() => caixa.remove(), opcoes.desfazer ? 8000 : 4000);
}

// ---- servidor

async function carregar() {
  const r = await fetch('/api/lista');
  const corpo = await r.json();
  if (!r.ok) throw new Error(corpo.erro ?? 'Não consegui ler a lista.');
  aplicarDocumento(corpo);
}

function aplicarDocumento(corpo) {
  estado.doc = corpo;
  $('#arquivo').textContent = corpo.arquivo;
  $('#arquivo').title = 'Arquivo em que esta lista fica guardada';
  $('#titulo').textContent = `Tarefas de ${corpo.projeto}`;
  document.title = `Tarefas de ${corpo.projeto}`;
  desenharFiltroDeModelos();
  desenhar();
}

function posicaoDa(id) {
  for (const g of estado.doc.grupos) {
    const i = g.tarefas.findIndex((t) => t.id === id);
    if (i >= 0) return { grupo: g, indice: i, antesDe: g.tarefas[i + 1]?.id ?? null };
  }
  return null;
}

async function mover(id, para, antesDe, { semDesfazer = false } = {}) {
  if (estado.ocupado) return;
  const antes = posicaoDa(id);
  if (!antes || (antes.grupo.id === para && antes.antesDe === antesDe)) return;
  estado.ocupado = true;
  try {
    const r = await fetch('/api/mover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, para, antesDe, versao: estado.doc.versao }),
    });
    const corpo = await r.json();
    if (r.status === 409) {
      aplicarDocumento(corpo);
      avisar(corpo.erro, { erro: true });
      return;
    }
    if (!r.ok) throw new Error(corpo.erro ?? 'Não consegui gravar.');
    aplicarDocumento(corpo);
    if (!semDesfazer) {
      const destino = estado.doc.grupos.find((g) => g.id === para);
      const texto = antes.grupo.id === para ? 'Ordem salva no arquivo.' : `Movida para ${nomeDoGrupo(destino)}.`;
      avisar(texto, { desfazer: () => mover(id, antes.grupo.id, antes.antesDe, { semDesfazer: true }) });
    }
  } catch (erro) {
    avisar(erro.message, { erro: true });
    carregar().catch(() => {});
  } finally {
    estado.ocupado = false;
  }
}

let problemaAvisado = null;

async function reler() {
  if (document.hidden || arrastando || estado.ocupado || !estado.doc) return;
  try {
    const r = await fetch('/api/versao');
    const { versao } = await r.json();
    if (versao !== estado.doc.versao) {
      await carregar();
      avisar('A lista foi atualizada a partir do arquivo.');
    }
    problemaAvisado = null;
  } catch (erro) {
    // A rede falha com TypeError; o resto é o arquivo que ficou ilegível, editado à mão.
    const texto = erro instanceof TypeError
      ? 'O servidor da lista parou. Peça ao Claude para abrir a lista, ou rode o comando abrir no terminal.'
      : `Não consegui ler o arquivo: ${erro.message}`;
    if (texto !== problemaAvisado) avisar(texto, { erro: true });
    problemaAvisado = texto;
  }
}

// ---- copiar: a área de transferência moderna e, se o navegador integrado a recusar, o caminho antigo

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = texto;
    area.setAttribute('readonly', '');
    area.className = 'copia-oculta';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

async function copiar(botao) {
  const id = botao.closest('[data-id]').dataset.id;
  const tarefa = estado.doc.grupos.flatMap((g) => g.tarefas).find((t) => t.id === id);
  const parte = tarefa.partes[Number(botao.dataset.indice)];
  if (!(await copiarTexto(parte.texto))) {
    avisar('Não consegui copiar. Abra a tarefa e selecione o texto.', { erro: true });
    return;
  }
  const rotulo = $('span', botao);
  const antes = rotulo.textContent;
  rotulo.textContent = 'Copiado';
  botao.classList.add('copiado');
  setTimeout(() => { rotulo.textContent = antes; botao.classList.remove('copiado'); }, 1600);
}

// ---- cliques

function alternar(conjunto, valor) {
  if (conjunto.has(valor)) conjunto.delete(valor);
  else conjunto.add(valor);
  guardarPreferencias();
  desenhar();
}

document.addEventListener('click', (e) => {
  const alvo = e.target.closest('[data-acao]');
  if (!alvo) return;
  const acao = alvo.dataset.acao;
  if (acao === 'mover-para') return;
  const id = alvo.closest('[data-id]')?.dataset.id;
  if (acao === 'tarefa') alternar(estado.tarefasAbertas, id);
  else if (acao === 'grupo') alternar(estado.gruposFechados, alvo.closest('[data-grupo]').dataset.grupo);
  else if (acao === 'prompt') alternar(estado.promptsAbertos, alvo.dataset.chave);
  else if (acao === 'copiar') copiar(alvo);
  else if (acao === 'subir' || acao === 'descer') {
    const { grupo, indice } = posicaoDa(id);
    const antesDe = acao === 'subir' ? grupo.tarefas[indice - 1]?.id : grupo.tarefas[indice + 1] && (grupo.tarefas[indice + 2]?.id ?? null);
    if (antesDe !== undefined) mover(id, grupo.id, antesDe);
  } else if (acao === 'expandir-tudo') {
    estado.gruposFechados.clear();
    for (const g of estado.doc.grupos) for (const t of g.tarefas.filter(passaNoFiltro)) estado.tarefasAbertas.add(t.id);
    guardarPreferencias();
    desenhar();
  } else if (acao === 'recolher-tudo') {
    estado.tarefasAbertas.clear();
    guardarPreferencias();
    desenhar();
  } else if (acao === 'nova-tarefa') {
    abrirNovaTarefa();
  } else if (acao === 'conferir-feitas') {
    abrirConferencia();
  } else if (acao === 'abrir-trabalho') {
    abrirTrabalho();
  } else if (acao === 'ir-grupo') {
    const grupo = alvo.dataset.grupo;
    if (estado.gruposFechados.delete(grupo)) { guardarPreferencias(); desenhar(); }
  }
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.acao === 'mover-para') mover(e.target.closest('[data-id]').dataset.id, e.target.value, null);
});

// ---- arrastar

function limparMarcas() {
  for (const el of document.querySelectorAll('.solta-antes, .solta-depois, .solta-grupo')) el.classList.remove('solta-antes', 'solta-depois', 'solta-grupo');
}

function destinoDoArraste(e) {
  const tarefa = e.target.closest('.tarefa');
  if (tarefa && tarefa.dataset.id !== arrastando) {
    const caixa = tarefa.getBoundingClientRect();
    const antes = e.clientY < caixa.top + Math.min(caixa.height, 44) / 2;
    return { tipo: 'tarefa', el: tarefa, antes };
  }
  if (tarefa) return null;
  const grupo = e.target.closest('.lateral-item, .grupo');
  return grupo ? { tipo: 'grupo', el: grupo } : null;
}

document.addEventListener('dragstart', (e) => {
  const tarefa = e.target.closest?.('.tarefa');
  if (!tarefa) return;
  arrastando = tarefa.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', arrastando);
  tarefa.classList.add('arrastando');
  document.body.classList.add('em-arraste');
});

document.addEventListener('dragover', (e) => {
  if (!arrastando) return;
  const destino = destinoDoArraste(e);
  limparMarcas();
  if (!destino) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (destino.tipo === 'tarefa') destino.el.classList.add(destino.antes ? 'solta-antes' : 'solta-depois');
  else destino.el.classList.add('solta-grupo');
});

document.addEventListener('drop', (e) => {
  if (!arrastando) return;
  e.preventDefault();
  const destino = destinoDoArraste(e);
  const id = arrastando;
  limparMarcas();
  if (!destino) return;
  if (destino.tipo === 'grupo') {
    mover(id, destino.el.dataset.grupo, null);
    return;
  }
  const alvo = posicaoDa(destino.el.dataset.id);
  let antesDe = destino.antes ? destino.el.dataset.id : alvo.antesDe;
  if (antesDe === id) antesDe = alvo.grupo.tarefas.find((t, i) => i > alvo.indice + 1)?.id ?? null;
  mover(id, alvo.grupo.id, antesDe);
});

document.addEventListener('dragend', () => {
  arrastando = null;
  limparMarcas();
  document.body.classList.remove('em-arraste');
  $('.arrastando')?.classList.remove('arrastando');
});

// ---- busca e filtros

$('#busca').addEventListener('input', (e) => { estado.busca = semAcento(e.target.value.trim()); desenhar(); });
$('#f-modelo').addEventListener('change', (e) => { estado.modelo = e.target.value; guardarPreferencias(); desenhar(); });
$('#f-situacao').addEventListener('change', (e) => { estado.situacao = e.target.value; guardarPreferencias(); desenhar(); });

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    $('#busca').focus();
  } else if (e.key === 'Escape' && document.activeElement === $('#busca')) {
    $('#busca').value = '';
    estado.busca = '';
    desenhar();
  }
});

// ---- início

carregarPreferencias();
$('#f-situacao').value = estado.situacao;
function mostrarTarefa(id) {
  estado.tarefasAbertas.add(id);
  const grupo = estado.doc.grupos.find((g) => g.tarefas.some((t) => t.id === id));
  if (grupo) estado.gruposFechados.delete(grupo.id);
  guardarPreferencias();
  desenhar();
  $(`[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
}

carregar()
  .then(() => iniciarJanelas({ doc: () => estado.doc, esc, avisar, aplicarDocumento, mostrarTarefa }))
  .catch((erro) => {
    $('#lista').innerHTML = `<p class="vazio-geral">${esc(erro.message)}</p>`;
  });
setInterval(reler, INTERVALO_RELEITURA);
document.addEventListener('visibilitychange', reler);
