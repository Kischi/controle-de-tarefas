/**
 * As duas janelas que consultam o Claude: "Nova tarefa", que revisa o prompt, e "Conferir feitas", que leva
 * à última seção o que já foi feito. A consulta roda no servidor: fechar a janela ou recarregar a página
 * não a interrompe, e a pílula do cabeçalho mostra o andamento.
 */
const CHAVE_RASCUNHO = 'controle-de-tarefas-rascunho-v1';
const INTERVALO = 1500;
const ESFORCOS = [['low', 'Baixo'], ['medium', 'Médio'], ['high', 'Alto'], ['xhigh', 'Muito alto'], ['max', 'Máximo']];
const NOME_ESFORCO = Object.fromEntries(ESFORCOS);
const nomeDoModelo = (m) => String(m ?? '')[0]?.toUpperCase() + String(m ?? '').slice(1);

let ctx = null;
let modo = null;
let trabalho = null;
let conta = null;
let aviso = '';
let resultadoAplicado = null;
const selecionadas = new Set();
const rascunho = { titulo: '', grupo: '1', prompt: '' };
const revisao = { titulo: '', grupo: '1', prompt: '', modelo: '', motivoModelo: '', dependeDe: '' };

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
const janela = () => $('#janela');
const conteudo = () => $('#janela-conteudo');

async function api(rota, corpo) {
  const r = await fetch(rota, corpo === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const erro = new Error(dados.erro ?? 'Não consegui falar com o servidor.');
    erro.dados = dados;
    throw erro;
  }
  return dados;
}

function guardarRascunho() {
  try { localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify(rascunho)); } catch { /* só uma conveniência */ }
}

function carregarRascunho() {
  try { Object.assign(rascunho, JSON.parse(localStorage.getItem(CHAVE_RASCUNHO) ?? '{}')); } catch { /* começa vazio */ }
}

const opcoes = (lista, atual) => lista.map(([valor, nome]) => `<option value="${ctx.esc(valor)}"${valor === atual ? ' selected' : ''}>${ctx.esc(nome)}</option>`).join('');
const gruposParaEscolher = () => ctx.doc().grupos.filter((g) => g.id !== ctx.doc().feitos).map((g) => [g.id, `${g.numero}. ${g.nome}`]);
const nomeDosFeitos = () => ctx.doc().grupos.find((g) => g.id === ctx.doc().feitos)?.nome ?? 'feitos';
const modelos = () => conta?.modelos ?? [];
const rotuloAplicar = (n) => (n === 1 ? 'Aplicar à selecionada' : n ? `Aplicar às ${n} selecionadas` : 'Selecione uma tarefa');
const lista = (itens) => `<ul>${itens.map((i) => `<li>${ctx.esc(i)}</li>`).join('')}</ul>`;

function tempo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

function topo(titulo) {
  return `<header class="janela-topo">
    <h2 id="janela-titulo">${ctx.esc(titulo)}</h2>
    <button type="button" class="janela-fechar" data-j="fechar" aria-label="Fechar">×</button>
  </header>`;
}

function notaDaConta() {
  if (!conta) return '';
  if (!conta.disponivel) return '<p class="janela-erro">O Claude Code não está disponível neste computador, ou não há login. A tarefa pode ser adicionada sem revisão.</p>';
  const dominio = conta.dominio ? `conta ${ctx.esc(conta.dominio)}` : 'conta deste computador';
  return `<p class="janela-nota">Usa o Claude Code ${ctx.esc(conta.versao ?? '')}, na ${dominio}. Ele só lê o projeto e não muda nada.</p>`;
}

const notaDoAviso = () => (aviso ? `<p class="janela-erro" role="alert">${ctx.esc(aviso)}</p>` : '');

function htmlDoAndamento(nome) {
  return `<div class="andamento" role="status">
    <span class="giro" aria-hidden="true"></span>
    <div>
      <strong>${ctx.esc(nome)} com ${ctx.esc(nomeDoModelo(trabalho.modelo))}, esforço ${ctx.esc(NOME_ESFORCO[trabalho.esforco] ?? trabalho.esforco)}</strong>
      <p id="andamento-atividade">${ctx.esc(trabalho.atividade)}</p>
      <p class="fraco" id="andamento-tempo"></p>
    </div>
  </div>
  <p class="janela-nota">Pode fechar esta janela: a consulta continua, e a pílula do cabeçalho avisa quando terminar.</p>
  <div class="janela-rodape"><span class="espaco"></span><button type="button" class="botao" data-j="cancelar">Cancelar a consulta</button></div>`;
}

function atualizarAndamento() {
  const atividade = $('#andamento-atividade');
  if (!atividade || !trabalho) return;
  atividade.textContent = trabalho.atividade;
  $('#andamento-tempo').textContent = `${tempo(Date.now() - trabalho.inicio)} · ${trabalho.passos} ${trabalho.passos === 1 ? 'consulta' : 'consultas'} ao projeto`;
}

function resumoDoCusto() {
  const partes = [];
  if (trabalho.fim) partes.push(`Levou ${tempo(trabalho.fim - trabalho.inicio)}`);
  if (typeof trabalho.custo === 'number') partes.push(`custo equivalente de US$ ${trabalho.custo.toFixed(2).replace('.', ',')}`);
  if (typeof trabalho.usoSemanal === 'number') partes.push(`cota semanal da conta em ${Math.round(trabalho.usoSemanal <= 1 ? trabalho.usoSemanal * 100 : trabalho.usoSemanal)}%`);
  return partes.length ? `<p class="janela-nota">${ctx.esc(partes.join(' · '))}.</p>` : '';
}

// ---- Nova tarefa

function htmlDoFormulario() {
  const disponivel = conta?.disponivel !== false;
  return `${topo('Nova tarefa')}
  ${notaDoAviso()}
  <div class="form">
    <label class="campo">Título<input data-c="titulo" value="${ctx.esc(rascunho.titulo)}" maxlength="120" autocomplete="off"></label>
    <label class="campo">Seção<select data-c="grupo">${opcoes(gruposParaEscolher(), rascunho.grupo)}</select></label>
    <label class="campo campo-largo">Prompt básico
      <textarea data-c="prompt" rows="12" spellcheck="true" placeholder="Escreva como vier: o Claude confere no código e melhora.">${ctx.esc(rascunho.prompt)}</textarea>
    </label>
  </div>
  ${notaDaConta()}
  <div class="janela-rodape">
    <label class="campo-linha">Esforço<select data-c="esforco">${opcoes(ESFORCOS, rascunho.esforco)}</select></label>
    <span class="espaco"></span>
    <button type="button" class="botao" data-j="adicionar-sem-revisar">Adicionar sem revisar</button>
    <button type="button" class="botao botao-forte" data-j="revisar"${disponivel ? '' : ' disabled'}>Revisar com o Claude</button>
  </div>`;
}

function htmlDaRevisao() {
  const r = trabalho.resultado;
  const textoOriginal = trabalho.entrada?.prompt ?? '';
  return `${topo('Revisão do prompt')}
  ${notaDoAviso()}
  <div class="comparacao">
    <section>
      <h3>O seu texto</h3>
      <pre tabindex="0">${ctx.esc(textoOriginal)}</pre>
    </section>
    <section>
      <h3>Revisado pelo Claude <small>pode editar</small></h3>
      <textarea data-r="prompt" spellcheck="true">${ctx.esc(revisao.prompt)}</textarea>
    </section>
  </div>
  <div class="revisao-notas">
    ${r.mudancas.length ? `<section><h3>O que mudou e por quê</h3>${lista(r.mudancas)}</section>` : ''}
    ${r.duvidas.length ? `<section class="destaque"><h3>Dúvidas para você</h3>${lista(r.duvidas)}</section>` : ''}
    ${r.interpretacoes.length ? `<section><h3>Interpretações do Claude</h3>${lista(r.interpretacoes)}</section>` : ''}
  </div>
  <div class="form">
    <label class="campo">Título<input data-r="titulo" value="${ctx.esc(revisao.titulo)}" maxlength="120" autocomplete="off"></label>
    <label class="campo">Seção<select data-r="grupo">${opcoes(gruposParaEscolher(), revisao.grupo)}</select></label>
    <label class="campo">Modelo recomendado<select data-r="modelo">${opcoes(modelos().map((m) => [m, m]), revisao.modelo)}</select></label>
    <label class="campo">Depende de<input data-r="dependeDe" value="${ctx.esc(revisao.dependeDe)}" autocomplete="off"></label>
    <label class="campo campo-largo">Por que esse modelo<input data-r="motivoModelo" value="${ctx.esc(revisao.motivoModelo)}" autocomplete="off"></label>
  </div>
  ${resumoDoCusto()}
  <div class="janela-rodape">
    <button type="button" class="botao" data-j="voltar">Voltar e editar</button>
    <span class="espaco"></span>
    <button type="button" class="botao" data-j="usar-meu-texto">Adicionar o meu texto</button>
    <button type="button" class="botao botao-forte" data-j="adicionar-revisado">Adicionar à lista</button>
  </div>`;
}

function carregarRevisao() {
  const r = trabalho.resultado;
  Object.assign(revisao, {
    titulo: trabalho.entrada?.titulo || r.titulo,
    grupo: trabalho.entrada?.grupo ?? '1',
    prompt: r.prompt,
    modelo: modelos().includes(r.modelo) ? r.modelo : modelos()[0] ?? '',
    motivoModelo: r.motivoModelo,
    dependeDe: r.dependeDe,
  });
}

function desenharNova() {
  const em = trabalho?.tipo === 'revisao' ? trabalho.estado : null;
  if (em === 'rodando') {
    conteudo().innerHTML = `${topo('Nova tarefa')}${htmlDoAndamento('Revisando')}`;
    atualizarAndamento();
  } else if (em === 'pronto') {
    if (resultadoAplicado !== trabalho.id) { carregarRevisao(); resultadoAplicado = trabalho.id; }
    conteudo().innerHTML = htmlDaRevisao();
  } else {
    conteudo().innerHTML = htmlDoFormulario();
  }
}

async function adicionar(campos) {
  aviso = '';
  try {
    const interpretacoes = trabalho?.resultado?.interpretacoes ?? [];
    const notas = campos.comNotas && interpretacoes.length
      ? `**Interpretações:**\n\n${interpretacoes.map((i) => `- ${i}`).join('\n')}`
      : '';
    const corpo = await api('/api/tarefa', { versao: ctx.doc().versao, notas, ...campos });
    ctx.aplicarDocumento(corpo);
    Object.assign(rascunho, { titulo: '', prompt: '' });
    guardarRascunho();
    if (trabalho?.tipo === 'revisao') { await api('/api/trabalho/limpar', {}); trabalho = null; atualizarPilula(); }
    janela().close();
    ctx.mostrarTarefa(corpo.novaTarefa);
    ctx.avisar('Tarefa adicionada à lista.');
  } catch (erro) {
    if (erro.dados?.grupos) ctx.aplicarDocumento(erro.dados);
    aviso = erro.message;
    desenhar();
  }
}

async function revisar() {
  aviso = '';
  guardarRascunho();
  try {
    trabalho = await api('/api/revisar', { titulo: rascunho.titulo, grupo: rascunho.grupo, prompt: rascunho.prompt, esforco: rascunho.esforco });
    acompanhar();
  } catch (erro) {
    aviso = erro.message;
  }
  desenhar();
}

// ---- Conferir feitas

const tarefasDoDoc = () => ctx.doc().grupos.flatMap((g) => g.tarefas.map((t) => ({ ...t, grupo: g.id })));
const registradas = () => tarefasDoDoc().filter((t) => t.categoria === 'feito' && t.grupo !== ctx.doc().feitos);

function linhaDeEscolha(t, detalhe, marcada) {
  return `<label class="escolha">
    <input type="checkbox" data-e="${ctx.esc(t.id)}"${marcada ? ' checked' : ''}>
    <span><strong>${ctx.esc(t.titulo)}</strong>${detalhe ? `<small>${ctx.esc(detalhe)}</small>` : ''}</span>
  </label>`;
}

function htmlDoResultadoDaConferencia() {
  const todas = new Map(tarefasDoDoc().map((t) => [t.id, t]));
  const achadas = (trabalho.resultado?.tarefas ?? []).filter((r) => todas.has(r.id) && todas.get(r.id).grupo !== ctx.doc().feitos);
  const feitas = achadas.filter((r) => r.situacao === 'feita');
  const parciais = achadas.filter((r) => r.situacao === 'em_parte');
  const conferidas = trabalho.resultado?.tarefas?.length ?? 0;
  const partes = [`<p class="janela-nota">O Claude conferiu ${conferidas} ${conferidas === 1 ? 'tarefa' : 'tarefas'}: ${feitas.length} ${feitas.length === 1 ? 'parece feita' : 'parecem feitas'} e ${parciais.length} em parte.</p>`];
  if (feitas.length) {
    partes.push(`<section><h3>Parecem feitas: vão para ${ctx.esc(nomeDosFeitos())}</h3>${feitas.map((r) => linhaDeEscolha(todas.get(r.id), `${r.confianca === 'alta' ? 'Confiança alta' : 'Confiança média'}. ${r.evidencia}`, selecionadas.has(r.id))).join('')}</section>`);
  }
  if (parciais.length) {
    partes.push(`<section><h3>Feitas em parte: ficam onde estão, com o registro</h3>${parciais.map((r) => linhaDeEscolha(todas.get(r.id), `Feito: ${r.feito} Falta: ${r.falta}`, selecionadas.has(r.id))).join('')}</section>`);
  }
  return partes.join('') + resumoDoCusto();
}

function desenharConferir() {
  const jaFeitas = registradas();
  const em = trabalho?.tipo === 'conferencia' ? trabalho.estado : null;
  const partes = [topo('Conferir feitas'), notaDoAviso()];
  partes.push(`<section class="bloco-conferir"><h3>Já registradas como feitas</h3>${jaFeitas.length
    ? jaFeitas.map((t) => linhaDeEscolha(t, t.situacaoLonga, selecionadas.has(t.id))).join('')
    : `<p class="janela-nota">Nenhuma tarefa registrada como feita está fora de ${ctx.esc(nomeDosFeitos())}.</p>`}</section>`);
  partes.push('<section class="bloco-conferir"><h3>Conferir no código</h3>');
  if (em === 'rodando') {
    partes.push(htmlDoAndamento('Conferindo'));
  } else if (em === 'pronto') {
    partes.push(htmlDoResultadoDaConferencia());
  } else {
    partes.push(`<p class="janela-nota">O ${ctx.esc(nomeDoModelo(conta?.conferencia?.modelo ?? 'Claude'))} compara as tarefas abertas com o código e com os commits recentes. As tarefas sem prompt ficam de fora, porque não há o que comparar. Nada é movido sem a sua confirmação aqui.</p>
    ${notaDaConta()}
    <div class="janela-rodape">
      <label class="campo-linha">Esforço<select data-c="esforcoConferir">${opcoes(ESFORCOS, rascunho.esforcoConferir)}</select></label>
      <span class="espaco"></span>
      <button type="button" class="botao" data-j="conferir"${conta?.disponivel === false ? ' disabled' : ''}>Conferir com o Claude</button>
    </div>`);
  }
  partes.push('</section>');
  if (em !== 'rodando') {
    partes.push(`<div class="janela-rodape">
      ${em === 'pronto' ? '<button type="button" class="botao" data-j="nova-conferencia">Conferir de novo</button>' : ''}
      <span class="espaco"></span>
      <button type="button" class="botao botao-forte" data-j="aplicar"${selecionadas.size ? '' : ' disabled'}>${rotuloAplicar(selecionadas.size)}</button>
    </div>`);
  }
  conteudo().innerHTML = partes.join('');
  atualizarAndamento();
}

function marcarPadraoDaConferencia() {
  for (const t of registradas()) selecionadas.add(t.id);
  if (trabalho?.tipo === 'conferencia' && trabalho.estado === 'pronto' && resultadoAplicado !== trabalho.id) {
    resultadoAplicado = trabalho.id;
    for (const r of trabalho.resultado?.tarefas ?? []) {
      if ((r.situacao === 'feita' || r.situacao === 'em_parte') && r.confianca === 'alta') selecionadas.add(r.id);
    }
  }
}

async function aplicarConferencia() {
  aviso = '';
  const achados = new Map((trabalho?.tipo === 'conferencia' ? trabalho.resultado?.tarefas ?? [] : []).map((r) => [r.id, r]));
  const jaFeitas = new Set(registradas().map((t) => t.id));
  const feitas = [];
  const parciais = [];
  for (const id of selecionadas) {
    const r = achados.get(id);
    if (jaFeitas.has(id)) feitas.push({ id });
    else if (r?.situacao === 'feita') feitas.push({ id, evidencia: r.evidencia });
    else if (r?.situacao === 'em_parte') parciais.push({ id, feito: r.feito, falta: r.falta });
  }
  try {
    const corpo = await api('/api/resolver', { versao: ctx.doc().versao, feitas, parciais });
    ctx.aplicarDocumento(corpo);
    selecionadas.clear();
    if (trabalho?.tipo === 'conferencia') { await api('/api/trabalho/limpar', {}); trabalho = null; atualizarPilula(); }
    janela().close();
    const n = feitas.length;
    const texto = [n && `${n} ${n === 1 ? 'tarefa movida' : 'tarefas movidas'} para ${nomeDosFeitos()}`, parciais.length && `${parciais.length} em parte`].filter(Boolean).join(' e ');
    ctx.avisar(`${texto}.`, {
      desfazer: async () => {
        try { ctx.aplicarDocumento(await api('/api/desfazer', {})); } catch (erro) { ctx.avisar(erro.message, { erro: true }); }
      },
    });
  } catch (erro) {
    if (erro.dados?.grupos) ctx.aplicarDocumento(erro.dados);
    aviso = erro.message;
    desenharConferir();
  }
}

// ---- comum

function desenhar() {
  if (modo === 'nova') desenharNova();
  else if (modo === 'conferir') desenharConferir();
}

function atualizarPilula() {
  const p = $('#pilula');
  if (!trabalho || trabalho.estado === 'cancelado') { p.hidden = true; return; }
  const nome = trabalho.tipo === 'revisao' ? 'Revisão' : 'Conferência';
  p.hidden = false;
  p.classList.toggle('pronta', trabalho.estado === 'pronto');
  p.classList.toggle('falhou', trabalho.estado === 'erro');
  p.textContent = trabalho.estado === 'rodando' ? `${nome} em andamento · ${tempo(Date.now() - trabalho.inicio)}`
    : trabalho.estado === 'pronto' ? `${nome} pronta` : `${nome} falhou`;
}

let acompanhando = null;

async function verificar() {
  try {
    const anterior = trabalho?.estado;
    trabalho = (await api('/api/trabalho')).trabalho;
    atualizarPilula();
    if (trabalho?.estado === 'rodando') {
      atualizarAndamento();
      return;
    }
    clearInterval(acompanhando);
    acompanhando = null;
    if (anterior === 'rodando' && janela().open) {
      if (trabalho?.estado === 'erro') aviso = trabalho.erro;
      if (modo === 'conferir') marcarPadraoDaConferencia();
      desenhar();
    }
  } catch { /* a página já avisa quando o servidor para */ }
}

function acompanhar() {
  atualizarPilula();
  if (!acompanhando) acompanhando = setInterval(verificar, INTERVALO);
}

async function abrir(novoModo) {
  modo = novoModo;
  aviso = trabalho?.estado === 'erro' ? trabalho.erro : '';
  try { conta = await api('/api/claude'); } catch { conta = { disponivel: false }; }
  rascunho.esforco ??= conta.revisao?.esforco ?? 'high';
  rascunho.esforcoConferir ??= conta.conferencia?.esforco ?? 'medium';
  if (modo === 'conferir') marcarPadraoDaConferencia();
  desenhar();
  if (!janela().open) janela().showModal();
}

export const abrirNovaTarefa = () => abrir('nova');
export const abrirConferencia = () => abrir('conferir');
export const abrirTrabalho = () => abrir(trabalho?.tipo === 'conferencia' ? 'conferir' : 'nova');

async function limparTrabalho() {
  await api('/api/trabalho/limpar', {}).catch(() => {});
  trabalho = null;
  atualizarPilula();
}

const acoes = {
  fechar: () => janela().close(),
  revisar,
  cancelar: async () => {
    await api('/api/trabalho/cancelar', {}).catch(() => {});
    await verificar();
    await limparTrabalho();
    desenhar();
  },
  voltar: async () => {
    rascunho.prompt = revisao.prompt;
    rascunho.titulo = revisao.titulo;
    rascunho.grupo = revisao.grupo;
    guardarRascunho();
    await limparTrabalho();
    desenhar();
  },
  'adicionar-sem-revisar': () => adicionar({ titulo: rascunho.titulo, grupo: rascunho.grupo, prompt: rascunho.prompt, modelo: 'A definir' }),
  'usar-meu-texto': () => adicionar({ titulo: revisao.titulo, grupo: revisao.grupo, prompt: trabalho.entrada?.prompt ?? '', modelo: revisao.modelo, motivoModelo: revisao.motivoModelo, dependeDe: revisao.dependeDe }),
  'adicionar-revisado': () => adicionar({ ...revisao, comNotas: true }),
  conferir: async () => {
    aviso = '';
    guardarRascunho();
    try {
      trabalho = await api('/api/conferir', { esforco: rascunho.esforcoConferir });
      acompanhar();
    } catch (erro) {
      aviso = erro.message;
    }
    desenhar();
  },
  'nova-conferencia': async () => { await limparTrabalho(); desenhar(); },
  aplicar: aplicarConferencia,
};

export function iniciarJanelas(contexto) {
  ctx = contexto;
  carregarRascunho();
  const raiz = janela();
  raiz.addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-j]');
    if (alvo) acoes[alvo.dataset.j]?.();
  });
  raiz.addEventListener('input', (e) => {
    const { c, r } = e.target.dataset;
    if (c) { rascunho[c] = e.target.value; guardarRascunho(); }
    if (r) revisao[r] = e.target.value;
  });
  raiz.addEventListener('change', (e) => {
    const id = e.target.dataset.e;
    if (!id) return;
    if (e.target.checked) selecionadas.add(id);
    else selecionadas.delete(id);
    const botao = $('[data-j="aplicar"]', raiz);
    if (botao) {
      botao.disabled = !selecionadas.size;
      botao.textContent = rotuloAplicar(selecionadas.size);
    }
  });
  verificar().then(() => { if (trabalho?.estado === 'rodando') acompanhar(); });
}
