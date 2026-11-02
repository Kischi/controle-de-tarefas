# Controle de tarefas para o Claude Code

Uma skill que dá a qualquer projeto uma lista de tarefas e de prompts, com uma página local que abre dentro do VS Code.

- Arraste as tarefas entre as seções, busque, filtre e copie cada prompt com um clique.
- Escreva uma tarefa como vier: o Claude confere no código, melhora o prompt e indica o melhor modelo.
- Peça ao Claude para conferir no código o que já foi feito.
- A lista é um arquivo Markdown, fora do git, que o Claude nunca segue sem um pedido seu.

## O que precisa

- [Claude Code](https://code.claude.com/docs)
- [Git](https://git-scm.com/)
- [Node 20 ou mais novo](https://nodejs.org/)
- VS Code, para ver a página dentro do editor. Sem ele, ela abre no navegador.

Testada no macOS, com o Node 24. Não depende de nada específico do macOS além de achar o Claude Code, mas não foi testada no Linux nem no Windows.

## Instalar

```bash
git clone https://github.com/Kischi/controle-de-tarefas.git ~/.claude/skills/controle-de-tarefas
```

A skill vale para todos os projetos deste computador. Sessões do Claude Code já abertas podem não vê-la: abra uma sessão nova.

## Usar

Num projeto, peça ao Claude:

> Crie um controle de tarefas para este projeto.

Ou use o comando `/controle-de-tarefas`. Na primeira vez, o Claude Code pode pedir permissão para usar a skill. Ele cria a pasta `.tarefas/`, liga a página e passa o endereço. No VS Code, pressione `Cmd+Shift+P` (`Ctrl+Shift+P` no Windows e no Linux), escolha "Browser: Open Integrated Browser" e cole o endereço.

Nas sessões seguintes, basta dizer "abra a minha lista", "anote isso na lista" ou "registre que essa tarefa foi feita".

## Quanto custa

A página não custa nada. A revisão de "Nova tarefa" e "Conferir feitas" usam a cota da sua conta do Claude Code, e cada consulta mostra o custo equivalente no fim. Com o Opus, uma revisão custou de US$ 0,13 a 0,17 com esforço Baixo e US$ 0,56 com o Máximo, num projeto pequeno. O esforço padrão é o Máximo, e você troca na própria janela ou em `.tarefas/config.json`.

## Privacidade

A lista fica só na sua máquina, em `.tarefas/`, fora do git. A página só atende neste computador. Nas consultas, o Claude só lê o projeto e não abre o que o git ignora nem os segredos comuns, como arquivos `.env` e chaves.

## Atualizar

```bash
git -C ~/.claude/skills/controle-de-tarefas pull
```

## Remover

```bash
rm -rf ~/.claude/skills/controle-de-tarefas
```

As listas dos projetos continuam em `.tarefas/`. Para desligar a página de um projeto antes de remover a skill, peça ao Claude ou rode `node ~/.claude/skills/controle-de-tarefas/pagina/servidor.mjs parar` na pasta do projeto.
