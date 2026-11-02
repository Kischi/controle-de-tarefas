# Como o controle de tarefas funciona

Leia antes de mudar o formato do arquivo ou o código da página.

## Sumário

- [Os arquivos](#os-arquivos)
- [O formato de tarefas.md](#o-formato-de-tarefasmd)
- [As configurações](#as-configurações)
- [O servidor](#o-servidor)
- [As consultas ao Claude](#as-consultas-ao-claude)
- [Decisões e o motivo de cada uma](#decisões-e-o-motivo-de-cada-uma)
- [Testes](#testes)

## Os arquivos

Na skill, em `pagina/`:

| arquivo | o que faz |
|---|---|
| `servidor.mjs` | os comandos e o servidor HTTP |
| `md.mjs` | lê e grava `tarefas.md`, e a trava `conferir` |
| `projeto.mjs` | a pasta do projeto, a porta, a configuração e o que o Claude não lê |
| `claude.mjs` | acha o Claude Code, monta os pedidos e acompanha a consulta |
| `index.html`, `app.js`, `estilo.css` | a tela da lista |
| `janelas.js` | as janelas Nova tarefa e Conferir feitas |

No projeto, em `.tarefas/`:

| arquivo | o que guarda |
|---|---|
| `tarefas.md` | a lista, que é a fonte oficial |
| `config.json` | os ajustes do projeto |
| `.gitignore` | um `*`, que esconde a pasta inteira do git |
| `.copias/` | as últimas 40 versões do arquivo, uma antes de cada gravação |
| `servidor.json`, `servidor.log` | a porta e o processo da página no ar, e o que ela imprimiu |

## O formato de tarefas.md

````markdown
# Controle de tarefas: nome do projeto

Cabeçalho livre, até a primeira seção numerada.

## 1. Nome da seção

> Descrição curta, numa linha só.

Introdução opcional, em Markdown.

<a id="t12"></a>

### Título da tarefa

- **Situação:** Pendente
- **Modelo:** Opus. Motivo em uma frase.
- **Depende de:** outra tarefa, pelo nome

Notas opcionais, em Markdown.

```text
O prompt, com cada parágrafo numa linha só.
```

## 2. Outra seção

> Descrição.

Ainda não há tarefas aqui.
````

As regras que o código assume:

- Uma seção é uma linha `## <número>. <nome>`. Outros títulos `##`, antes da primeira seção, são cabeçalho.
- A última seção é a dos feitos. A que começa por "Ideias", se houver, é a das sugestões: uma tarefa nova ali nasce como sugestão.
- A âncora `<a id="t12"></a>` é a identidade da tarefa. Ela nunca muda e não diz a seção.
- A frase "Ainda não há tarefas aqui." é escrita e tirada pelo código, nas seções sem tarefas.
- O que estiver num bloco de código nunca é interpretado: um `## 9. Algo` dentro de um prompt continua sendo prompt.
- A Situação começa por `Pendente`, `Sugestão`, `Feito em dd/mm/aaaa` ou `Feito em parte em dd/mm/aaaa`. É por esse começo que a página classifica a tarefa.
- A categoria do Modelo é a primeira palavra antes do primeiro ponto seguido de espaço: `Opus 5.5. Motivo.` vira `opus`, que dá o filtro e a cor da etiqueta.
- Uma seção pode ter texto livre na introdução, como itens antigos em lista: o código o preserva.

## As configurações

`.tarefas/config.json`, lido a cada consulta. O que faltar vem de `CONFIG_PADRAO`, em `projeto.mjs`.

| chave | o que é |
|---|---|
| `revisao` | `modelo` e `esforco` padrão da Nova tarefa. O modelo pode ser um apelido, como `opus`, que sempre aponta para a versão atual. |
| `conferencia` | o mesmo, para Conferir feitas. |
| `modelosDeTarefa` | `nome` e `quando` de cada modelo que uma tarefa pode recomendar. Vira a orientação ao revisor, as opções da tela e o formato da resposta. |
| `regrasDaRevisao` | frases a mais para o revisor, como textos que todo prompt do projeto deve levar. |
| `leituraNegada` | caminhos a mais que o Claude não lê, como `./planilhas/**`. |

O esforço escolhido na janela fica guardado naquele navegador, por projeto. Para trocar a conta das consultas, inicie o servidor com `CLAUDE_CONFIG_DIR` apontando para outra pasta de configuração do Claude Code.

## O servidor

Só atende em 127.0.0.1. Confere o `Host` e o `Origin` e exige JSON nas gravações, para outro site aberto no navegador não falar com ele.

| rota | o que faz |
|---|---|
| `GET /`, `/app.js`, `/janelas.js`, `/estilo.css` | a tela, guardada na memória ao ligar |
| `GET /api/versao` | o hash do arquivo, para a tela perceber mudanças, e a versão do código |
| `GET /api/lista` | a lista inteira |
| `GET /api/claude` | se há Claude Code e login, com os modelos e os esforços |
| `GET /api/trabalho` | o andamento da consulta |
| `POST /api/mover`, `/api/tarefa`, `/api/resolver` | gravam, e recusam com 409 se o arquivo mudou desde a leitura |
| `POST /api/desfazer` | volta a última conferência aplicada |
| `POST /api/revisar`, `/api/conferir` | começam uma consulta |
| `POST /api/trabalho/cancelar`, `/api/trabalho/limpar` | encerram a consulta |

Toda gravação relê o arquivo, passa por `conferir`, guarda a cópia e grava num temporário, renomeado no fim.

## As consultas ao Claude

`claude.mjs` chama `claude -p` com `--tools Read,Grep,Glob`, `--permission-mode dontAsk`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence` e `--json-schema`, e lê o `stream-json` para mostrar o andamento. Uma consulta por vez, com 30 minutos no máximo.

O programa é procurado no PATH, depois em `~/.local/bin`, e por fim na extensão do editor e no app, onde vence a versão mais nova. `TAREFAS_CLAUDE_BIN` indica outro.

O que fica de fora da leitura sai de `regrasDeLeituraNegada`: a própria `.tarefas/`, os segredos comuns, `leituraNegada` e tudo o que `git ls-files --ignored` lista naquele momento.

As consultas não leem chave de API do ambiente, para não cobrar por fora da assinatura. Quem só usa chave de API vê a página sem os dois botões de consulta.

## Decisões e o motivo de cada uma

- **O arquivo é a fonte, não um banco.** O Claude, em qualquer conta ou sessão, e o editor precisam escrever nele. A página é só uma vista.
- **Sem dependências.** Só o Node, para funcionar em qualquer projeto sem `npm install` e sem tocar no `package.json` dele.
- **Sem índice no arquivo.** Uma tabela de tarefas no topo duplicava títulos e situações. Saía de sincronia quando alguém editava à mão e obrigava a escrever em dois lugares ao registrar uma tarefa.
- **Tarefas sem número na tela.** Com a ordem livre, o número enganava: depois de um arraste, nada mais batia. As tarefas se citam pelo nome.
- **`.tarefas/` com o próprio `.gitignore`.** Mexer no `.gitignore` do projeto seria um arquivo versionado alterado por uma lista pessoal.
- **Só a pasta principal.** Numa worktree, a lista não existe, por estar fora do git: o comando vai à pasta principal do repositório.
- **Porta por projeto.** Sai do hash do caminho, para o endereço não mudar e dois projetos abertos não disputarem a mesma porta.
- **Servidor com a tela na memória, e `abrir` que troca o servidor antigo.** Se a tela viesse do disco a cada pedido, uma atualização da skill deixaria uma tela nova falando com um servidor velho.
- **`--disable-slash-commands`, `--strict-mcp-config` e sem CLAUDE.md nem memória.** Num projeto com CLAUDE.md de 400 KB, a base de cada chamada passou de 8 mil para 196 mil tokens, mesmo para responder "ok".
- **A conferência nunca move sozinha.** Ela só pré-marca o que tem confiança alta, e a pessoa confirma.
- **Copiar com dois caminhos.** O navegador integrado pode recusar a área de transferência moderna; o `execCommand` fica como plano B.
- **Linhas longas nos prompts.** O editor já quebra na largura do painel; uma quebra à mão somada a ela deixa o texto com linhas irregulares.

## Testes

```bash
node --test pagina/testes/*.test.mjs
```

Os testes rodam em pastas temporárias, com git de verdade, e nunca chamam o Claude. Mudou o formato do arquivo: ajuste `md.mjs`, acrescente o caso em `md.test.mjs` e confira que ler e regravar não muda um byte.
