# Jornada Clara

Controle interno de jornada para uma única empresa. O primeiro objetivo é aprender com o uso real da equipe. Este projeto não se apresenta como REP-P nem como sistema oficial de registro eletrônico de ponto.

## Stack inicial

- React + Vite para a aplicação web responsiva.
- Supabase Auth e PostgreSQL para autenticação e persistência. O projeto remoto Jornada Clara foi criado em São Paulo, o cliente está configurado localmente e a migração inicial foi aplicada.
- JavaScript com módulos ES.

## Estado atual

A tela de marcação usa Supabase Auth e carrega/grava os pontos do dia no banco. A aplicação agora inclui navegação por perfil, histórico e saldo mensal, solicitações de ajuste, visão de equipe, aprovações, ausências, gestão de perfis e jornadas, calendário, feriados e fechamento mensal. Os novos fluxos dependem da migração `202610270002_role_workflows.sql`; a criação de contas dentro do app também depende do deploy da Edge Function `admin-users`. Veja `supabase/migrations/README.md`. Não usar este controle interno como REP-P nem como sistema oficial de registro eletrônico de ponto.

## Regras de jornada acordadas

- Carga horária de 44 horas por semana, distribuída de segunda a sexta-feira.
- Jornada diária de 8h48min, com horário flexível de entrada.
- Intervalo de almoço mínimo de 1 hora.
- Ordem obrigatória das marcações: entrada do expediente → início do almoço → fim do almoço → fim do expediente.
- Marcações são registradas sem aprovação. Alterações devem ser solicitadas com justificativa e analisadas pelo gestor; o registro original deve ser preservado.
- O banco de horas deve ser compensado dentro do próprio mês. Saldos não compensados serão tratados na folha e zerados na virada do mês.
- Considerar feriados nacionais brasileiros.
- Localização não será solicitada nem coletada no primeiro momento.

## Perfis

- **Funcionário:** marca e consulta o próprio ponto; solicita alterações ou exclusões.
- **Gestor:** usa o próprio ponto, acompanha todos os funcionários, decide solicitações dos funcionários e lança ocorrências como atestados e férias. Alterações feitas por gestor seguem para aprovação do Admin Master.
- **Admin Master:** administra usuários, perfis, jornadas e abertura/fechamento dos períodos.

Atestados e férias contam como jornada diária completa (8h48min) e não alteram o saldo mensal. O Admin Master pode abrir ou fechar o calendário da empresa inteira ou de um funcionário específico.

## Ordem do trabalho

1. Construir e validar os fluxos funcionais conforme `docs/escopo-inicial.md`.
2. Depois, fazer uma etapa dedicada de melhoria visual com a skill frontend.

## Estrutura

```text
src/
  app/                 composição da aplicação e navegação
  features/            funcionalidades organizadas por domínio
    attendance/        marcações e jornada diária
    adjustments/       solicitações de alteração
    reports/           consultas e exportações
    schedules/         jornadas e regras de horário
    team/              funcionários e gestores
  shared/              componentes e utilitários compartilhados
    components/        elementos reutilizáveis da interface
    lib/               integrações externas e configuração
    styles/            estilos globais e tokens visuais
supabase/
  migrations/          mudanças versionadas no banco de dados
docs/                  escopo, arquitetura e decisões do produto
```

## Desenvolvimento local

```bash
npm install
npm run dev
```

O arquivo `.env.local` deste workspace já aponta para o projeto Jornada Clara e não é versionado. Em outra cópia, copie `.env.example` e preencha a URL e a chave publicável. Nunca use nem comite a chave `service_role` no frontend ou no repositório. Veja `supabase/migrations/README.md` para criar a primeira conta Admin Master.

## Direção futura

O controle interno poderá informar decisões futuras. Um eventual produto que busque conformidade REP-P será tratado como uma etapa própria, com análise e validação independentes. Não se deve inferir conformidade REP-P a partir deste projeto.
