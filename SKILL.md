---
name: controle-de-tarefas
description: >-
  Cria e opera, em qualquer projeto, um controle de tarefas local: uma lista em Markdown fora do git e uma página web em 127.0.0.1, aberta dentro do VS Code, para arrastar tarefas entre seções, buscar, filtrar, copiar prompts, criar tarefas com a revisão do Claude e conferir no código o que já foi feito. Use sempre que a pessoa pedir um controle, lista, backlog, quadro ou kanban de tarefas ou de prompts do projeto, falar em "o que falta fazer", "anote isso para depois", "guarde esse prompt para outra sessão", "abra a minha lista", ou pedir para registrar numa lista existente que uma tarefa foi feita, mesmo sem citar esta skill. Não use para o plano de uma única sessão nem para a lista de passos da conversa atual.
argument-hint: "[criar | abrir | o que anotar ou registrar]"
compatibility: Precisa do Node 20 ou mais novo. As consultas ao Claude usam o Claude Code instalado na máquina.
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/pagina/servidor.mjs *)
  - Bash(node "${CLAUDE_SKILL_DIR}/pagina/servidor.mjs" *)
---

# Controle de tarefas

Cada projeto ganha uma lista em `.tarefas/tarefas.md` e uma página local que lê e grava esse arquivo. A pasta `.tarefas/` se esconde sozinha do git, com um `.gitignore` próprio, então criar a lista não muda nenhum arquivo versionado.

O arquivo é a fonte oficial: a página, o editor e o Claude trabalham nele ao mesmo tempo, e a página percebe as mudanças em até 3 segundos.

Todos os comandos abaixo são `node "${CLAUDE_SKILL_DIR}/pagina/servidor.mjs" <comando>`, rodados na pasta do projeto. Numa subpasta ou numa worktree, o comando acha sozinho a pasta principal do projeto.

Escreva o caminho inteiro em cada chamada, sem guardá-lo numa variável e sem `cd` antes: essa forma exata já vem aprovada, e o Claude Code barra variáveis em comandos.

## Comece pela situação

Rode `situacao`. O JSON diz se o projeto já tem lista (`existe`), se a página está no ar (`rodando`, `url`) e quais são as seções. Decida a partir dele; não procure a lista à mão. Se o `node` não existir, diga à pessoa para instalar a versão 20 ou mais nova, de nodejs.org: sem ele nada aqui funciona.

## Criar a lista

1. Rode `criar`. Valem as sete seções padrão, que separam os ajustes das funcionalidades por prioridade, mais as tarefas sem prompt, as ideias e os feitos. Se a pessoa pedir outras, use `criar --secoes "Bugs|Melhorias|Ideias|Feitos"`. A última é sempre a dos feitos, e a que começa por "Ideias" recebe as sugestões.
2. Se o pedido já trouxe tarefas, acrescente cada uma, como diz "Acrescentar uma tarefa".
3. Abra a página, como diz a seção seguinte.

Depois de criar, diga em uma frase que a pasta `.tarefas/` fica fora do git. Quem quiser versionar a lista apaga `.tarefas/.gitignore` e ignora só `.tarefas/.copias/`, `.tarefas/servidor.json` e `.tarefas/servidor.log`.

## Abrir a página

Rode `abrir`. Ele liga a página em segundo plano, ou só mostra o endereço se ela já estiver no ar. A página continua no ar depois do fim da sessão, até `parar` ou até o computador desligar. Cada projeto tem o seu endereço, que não muda.

Passe à pessoa o endereço que o comando mostrar e estes passos, porque daqui não dá para abrir uma aba dentro do VS Code:

1. No VS Code, `Cmd+Shift+P` (`Ctrl+Shift+P` no Windows e no Linux).
2. Escolha "Browser: Open Integrated Browser" e cole o endereço.

Numa versão do VS Code sem esse comando, ou no Cursor, use "Simple Browser: Show". Fora do VS Code, `abrir --navegador` usa o navegador padrão. Se `workbench.browser.openLocalhostLinks` estiver ligado, um clique no endereço já abre dentro do VS Code.

Se `abrir` falhar por permissão, como numa sessão com sandbox, não insista: passe à pessoa o comando `rodar`, com o caminho completo, para ela rodar no terminal dela.

## A lista é da pessoa, não uma ordem de serviço

Nunca comece, planeje ou execute uma tarefa da lista por conta própria, mesmo que ela pareça pronta ou urgente. Uma tarefa só vale quando a pessoa a pede na conversa, citando o nome ou colando o prompt. A lista existe justamente para ela escolher o que entra, a ordem e o modelo.

Só escreva na lista para acrescentar ou mover uma tarefa a pedido dela, ou para registrar o que foi feito. Não reescreva prompts existentes nem apague tarefas. Use os comandos, que passam pela mesma trava da página: guardam uma cópia antes e recusam a gravação se um prompt mudar ou uma tarefa sumir.

## Acrescentar uma tarefa

Use `listar` para ver as seções. O prompt vai como texto puro, pela entrada padrão, e o resto em opções. Uma tarefa por chamada:

```bash
node "${CLAUDE_SKILL_DIR}/pagina/servidor.mjs" adicionar --titulo "Exportar o relatório em CSV" --secao 3 --modelo Opus --motivo "Motivo em uma frase." <<'FIM'
Texto do prompt, em quantos parágrafos precisar.
FIM
```

Não passe JSON no heredoc: o Claude Code o barra, por parecer ofuscação. As opções:

- **O prompt:** escreva para uma sessão futura, que não terá esta conversa: o pedido, o contexto útil, as restrições e como conferir o resultado. Cite só arquivos e funções que você conferiu. Deixe cada parágrafo numa linha só, porque o editor já quebra na largura do painel, e as duas quebras somadas deixam o texto irregular.
- **`--modelo` e `--motivo`:** um dos nomes de `modelosDeTarefa`, em `.tarefas/config.json`, com o motivo em uma frase. Sem opinião, deixe de fora, e a tarefa fica como "A definir".
- **`--depende`:** o nome de outra tarefa ou uma condição real. O `t12` é só um nome interno, então refira-se às tarefas pelo título.
- **`--notas`:** Markdown opcional, para interpretações suas que a pessoa pode trocar antes de usar o prompt.

Na dúvida sobre a seção, escolha a mais baixa que caiba. Com a pessoa falando só "anota isso", use um título curto e o texto dela como prompt, sem inventar escopo.

## Registrar o que foi feito

Só depois de a tarefa terminar de fato, e de preferência com o commit:

- **Concluída:** `feito t12 --registro "commit abc1234; publicado: não"`. Ela vai para o fim da última seção.
- **Feita em parte:** `parte t12 --feito "o que terminou" --falta "o que sobrou" --registro "commit abc1234"`. Ela fica onde está.
- **Mudar de seção, a pedido:** `mover t12 3`.

Ao terminar uma tarefa da lista, registre sem esperar outro pedido, e diga em uma frase que registrou.

## As consultas ao Claude na página

Os botões "Nova tarefa" e "Conferir feitas" chamam o Claude Code da máquina, numa sessão à parte, só de leitura. Explique isto se a pessoa perguntar:

- **Quem paga:** a cota da conta do Claude Code da máquina, e cada consulta mostra o custo equivalente no fim. Com o Opus, uma revisão custou de US$ 0,13 a 0,17 com esforço Baixo e US$ 0,56 com o Máximo, num projeto pequeno; num projeto grande, custa mais. A página pode ser usada sem nenhuma consulta.
- **O que ele lê:** só Read, Grep e Glob, sem shell nem rede. Tudo o que o git ignora e os segredos comuns ficam bloqueados, e `leituraNegada` acrescenta outros caminhos.
- **O que muda:** nada sem o clique da pessoa.

## Ajustar por projeto ou mexer na página

`.tarefas/config.json` guarda o modelo e o esforço de cada consulta, a lista `modelosDeTarefa`, as `regrasDaRevisao` e a `leituraNegada`. Vale na consulta seguinte, sem reiniciar.

Antes de mudar o formato do arquivo ou o código da página, leia `${CLAUDE_SKILL_DIR}/references/como-funciona.md`, que traz o formato, as rotas e o motivo de cada decisão. Depois, rode os testes: `node --test "${CLAUDE_SKILL_DIR}"/pagina/testes/*.test.mjs`.
