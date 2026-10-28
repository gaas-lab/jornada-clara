# Supabase migrations

As mudanças de banco ficam versionadas nesta pasta. A migração inicial cria a base para uma única empresa, com perfis, jornadas, feriados, bloqueios de calendário, marcações, pedidos de alteração, ausências e fechamentos mensais. A segunda migração acrescenta hierarquia de gestores, correções auditáveis, RPCs protegidas e operações administrativas.

## Projeto conectado

O projeto Jornada Clara está em São Paulo (`sa-east-1`). A migração inicial foi aplicada pelo SQL Editor do dashboard. Para novas mudanças, adicione uma migração versionada e revise o destino antes de aplicar. Se usar o CLI, inicialize a configuração, vincule o projeto correto com `supabase link` e aplique com `supabase db push`.

Como a primeira migração foi aplicada pelo SQL Editor, o histórico interno do CLI pode não registrar sua versão. Antes do primeiro `supabase db push`, confira `supabase migration list`; se a versão `202610270001` aparecer ausente no remoto, registre-a como aplicada com `supabase migration repair 202610270001 --status applied`. Esse comando ajusta apenas o histórico; não executa o SQL novamente.

Não aplique a migração em produção antes de revisar o SQL e conferir o projeto vinculado. Nunca coloque a `service_role` key no frontend.

## Primeira conta Admin Master

1. Crie ou convide a conta inicial em Authentication → Users. O cadastro público do app está desativado.
2. Copie o UUID dessa conta em Authentication → Users.
3. No SQL Editor, promova somente essa conta:

```sql
update public.profiles
set role = 'admin_master'
where id = '<UUID_DA_CONTA_INICIAL>';
```

4. O cadastro público do Supabase Auth permanece desativado. A criação dentro do app usa a Edge Function protegida `admin-users`, que cria a conta com Supabase Auth Admin e persiste o segredo apenas no ambiente gerenciado do Supabase.

## Publicar os fluxos por perfil

1. Revise `202610270002_role_workflows.sql` e aplique-o ao projeto Jornada Clara pelo SQL Editor. Ele adiciona as RPCs de solicitação/aprovação, equipe, jornada, calendário, feriados e fechamento mensal. A view `effective_attendance_punches` aplica as correções aprovadas sem substituir a marcação original.
2. Para permitir Admin Master como gestor responsável, aplique também `202610280001_allow_admin_master_responsible.sql`.
3. Faça deploy da função pelo Supabase CLI: `supabase functions deploy admin-users --project-ref ebgdgyxxrhsohqbrdpdh`. Ela usa `SUPABASE_SERVICE_ROLE_KEY` somente no ambiente das Edge Functions; nunca defina essa chave na Vercel nem no frontend.
4. As variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` ficam no ambiente Preview/Production da Vercel conforme a implantação. A chave publicável é destinada ao cliente; a chave `service_role` não é.

O Admin Master pode criar contas, ajustar perfil/equipe/jornada e desativar acessos. A desativação mantém o histórico e substitui a exclusão definitiva da conta. A importação do calendário preenche os feriados nacionais fixos e calcula a Paixão de Cristo do ano selecionado. Feriados estaduais e municipais ficam fora desse modelo.

A tabela `company_holidays` começa vazia. O registro de ponto só rejeita datas cadastradas nela; cadastre e confira o calendário nacional antes de usar a marcação como controle da equipe.

## Escopo desta versão

O registro individual continua disponível via `public.register_attendance_punch()`, sem escrita direta na tabela. As operações administrativas são RPCs com verificações de papel/escopo; criação de contas Auth é feita pela Edge Function. Antes de usar qualquer fluxo novo no projeto remoto, aplique a migração `202610270002_role_workflows.sql` e publique `admin-users`.
