# Escopo do primeiro momento

## Objetivo

Construir primeiro um app funcional de controle interno de jornada para uma única empresa. O app não será apresentado como REP-P nem como sistema oficial de registro eletrônico de ponto. Depois do produto funcional, será feita uma etapa própria de melhoria visual usando a skill de frontend.

## Regras de jornada

| Tema | Regra |
| --- | --- |
| Carga semanal | 44 horas |
| Dias de trabalho | Segunda a sexta-feira, exceto feriados nacionais brasileiros |
| Carga diária | 8h48min de trabalho efetivo |
| Entrada | Flexível, sem horário pré-definido |
| Almoço | Duração mínima de 1 hora |
| Sequência | Entrada expediente → início almoço → fim almoço → fim expediente |
| Marcações | Registradas sem aprovação |
| Alterações ou exclusões | Solicitadas pelo funcionário e submetidas à aprovação do gestor |
| Banco de horas | Compensação dentro do próprio mês |
| Fechamento mensal | Saldo positivo ou negativo não utilizado vai para tratamento em folha e zera no mês seguinte |
| Localização | Fora do escopo inicial; não solicitar nem registrar localização |

## Perfis e permissões

### Funcionário

- Bater ponto seguindo a sequência obrigatória.
- Consultar o próprio histórico, calendário, jornada, saldo e relatórios disponíveis.
- Consultar comprovantes e dados associados às próprias marcações.
- Solicitar alteração ou exclusão de marcação com justificativa.
- Acompanhar o estado da solicitação (pendente, aprovada ou recusada) e a decisão do gestor.

### Gestor

- Usar as funções disponíveis ao funcionário para o próprio ponto.
- Consultar os pontos de todos os funcionários.
- Aprovar ou recusar solicitações de alteração/exclusão enviadas pelos funcionários.
- Lançar ocorrências e alterações administrativas, como atestados e férias.
- Encaminhar alterações/exclusões feitas pelo próprio gestor ao Admin Master para aprovação.
- Consultar dados de equipe necessários para a gestão.

### Admin Master

- Acesso total de administração do app.
- Criar, editar, desativar e remover usuários conforme as regras de retenção do sistema.
- Alterar o perfil de acesso dos usuários.
- Configurar a jornada de cada usuário.
- Abrir ou fechar o calendário/período para toda a empresa ou para um funcionário específico.
- Consultar e administrar os dados de todos os usuários.

As permissões devem ser aplicadas também na camada de dados, não apenas ocultando ações na interface.

## Conteúdo funcional do app

O app funcional deve manter a experiência e os recursos que o app atual já oferece, adaptados aos três perfis:

- Marcação e estado da jornada do dia.
- Cálculo de jornada, previsão de saída, intervalo e saldo de horas.
- Histórico e calendário de marcações.
- Visão de saldo e relatório mensal.
- Exportação para PDF e planilha.
- Perfil do usuário.
- Instalação como PWA, tema escuro e notificações, quando disponíveis no navegador.
- Administração de usuários e jornadas conforme permissões de gestor e Admin Master.
- Aprovação e histórico de alterações/exclusões.
- Lançamento de atestados e férias pelo gestor.
- Abertura/fechamento do período de lançamento pelo Admin Master.

## Critérios de comportamento

- O sistema só permite a próxima marcação válida da sequência definida.
- Uma marcação normal aparece no histórico sem aguardar aprovação.
- O funcionário não altera nem apaga diretamente uma marcação já registrada; envia uma solicitação com justificativa.
- A decisão de aprovação ou recusa deve identificar quem decidiu (gestor ou Admin Master) e a data da decisão.
- O histórico deve preservar o valor original e registrar valores propostos, motivo e resultado da solicitação.
- Atestados e férias lançados pelo gestor contam como jornada diária completa (8h48min) e não alteram o saldo do mês.
- O gestor pode consultar todos os funcionários; o Admin Master consulta e administra todos os perfis.
- O Admin Master pode fechar ou abrir o calendário para toda a empresa e também individualmente por funcionário.
- Períodos fechados bloqueiam novas marcações no escopo bloqueado; reabertura é ação exclusiva do Admin Master.
- O banco de horas é apurado por mês; o fechamento guarda o saldo encaminhado à folha e inicia o próximo mês zerado.
- O primeiro momento do app não solicita nem registra localização.

## Questões a fechar antes dos fluxos detalhados

- O ponto pode ser marcado sem conexão? Se sim, quando fica confirmado?
- Qual será a fonte atualizável para os feriados nacionais brasileiros?
- Como deve funcionar exclusão de usuário sem apagar o histórico necessário?
