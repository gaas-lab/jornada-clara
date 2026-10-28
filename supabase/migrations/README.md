# Supabase migrations

As mudanças de banco ficam versionadas nesta pasta. A migração inicial cria a base para uma única empresa, com perfis, jornadas, feriados, bloqueios de calendário, marcações, pedidos de alteração, ausências e fechamentos mensais.

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

4. O cadastro público do Supabase Auth já está desativado. Até o fluxo Admin Master ser implementado, novas contas devem ser criadas ou convidadas pelo dashboard do Supabase.

A tabela `company_holidays` começa vazia. O registro de ponto só rejeita datas cadastradas nela; cadastre e confira o calendário nacional antes de usar a marcação como controle da equipe.

## Escopo desta fundação

O registro individual de ponto está disponível via `public.register_attendance_punch()`, sem escrita direta na tabela. O app já autentica e sincroniza a marcação individual. Pedidos, decisões, gestão de usuários/jornadas, ausências, bloqueios e fechamentos têm tabelas, mas suas operações seguras e telas ainda precisam ser implementadas.
