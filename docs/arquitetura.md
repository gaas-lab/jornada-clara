# Arquitetura inicial

## Princípios

- Manter a lógica de cálculo da jornada separada dos componentes React.
- Organizar funcionalidades por domínio para permitir evolução sem concentrar tudo em uma tela ou arquivo.
- Tratar marcações e alterações como conceitos distintos: marcação original é um evento; correção é uma solicitação auditável.
- Manter credenciais fora do repositório e aplicar autorização também no banco.
- Começar para uma empresa, sem introduzir suporte multiempresa antes de existir necessidade real.
- Representar explicitamente os três papéis do MVP: funcionário, gestor e Admin Master.
- Separar autorização por papel das regras de visibilidade de dados: funcionário vê o próprio histórico; gestor vê todos os funcionários; Admin Master administra todos os perfis.

## Camadas planejadas

1. **Interface (`app`, `features`, `shared/components`)** — telas, navegação e componentes.
2. **Domínio (`features/*/domain`)** — regras puras de sequência, duração, saldo e fechamento mensal.
3. **Aplicação (`features/*/services`)** — casos de uso, validações e coordenação entre domínio e persistência.
4. **Infraestrutura (`shared/lib`, `supabase`)** — cliente Supabase, autenticação, consultas e armazenamento.

## Estrutura alvo

```text
src/
  app/
  features/
    attendance/
      components/
      domain/
      services/
    adjustments/
      components/
      services/
    reports/
    schedules/
      domain/
    team/
  shared/
    components/
    lib/
    styles/
supabase/
  migrations/
docs/
```

## Persistência

A migração inicial em `supabase/migrations/202610270001_initial_schema.sql` foi aplicada ao projeto Jornada Clara e habilita RLS nas tabelas públicas. O app autentica com Supabase Auth e carrega as marcações do dia. Marcações originais são gravadas por uma função validada do banco; a aplicação não recebe permissão para alterar ou apagar marcações diretamente. Solicitações, ausências, bloqueios e fechamentos têm tabelas próprias, com operações ainda pendentes de implementação.

O cliente está em `src/shared/lib/supabase.js`. A URL e a chave publicável ficam em `.env.local`, ignorado pelo Git. Chaves secretas nunca podem ir para o bundle do navegador.

## Fora da fundação atual

- Requisitos técnicos e promessa de conformidade REP-P.
- Integrações de folha de pagamento.
- Rastreamento contínuo ou histórico de localização fora da marcação.
- Coleta de localização, inclusive no momento da marcação, no primeiro momento do produto.
- Arquitetura multiempresa.

## Experiência de desenvolvimento

Primeiro serão implementados fluxos funcionais e regras de negócio. A etapa de refinamento visual será planejada depois, usando a skill frontend conforme pedido.
