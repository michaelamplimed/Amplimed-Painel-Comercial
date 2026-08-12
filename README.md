# Amplimed — Painel Vivo

Painel comercial que se atualiza sozinho, de hora em hora (7h–19h, horário de
Brasília), sem depender de ninguém rodar nada manualmente.

## Como funciona

```
GitHub Actions (roda de hora em hora)
        │
        ▼
scripts/fetch-hubspot-data.js  ──▶  busca deals reais no HubSpot
        │
        ▼
   data/data.json  ──▶  commitado automaticamente no repositório
        │
        ▼
   index.html  ──▶  lê data/data.json ao carregar, hospedado no GitHub Pages
```

**O que já está automatizado (v1 + Fase 2):** Receita realizada do mês, %
da meta, receita média/dia, pipeline aberto, gráfico de receita acumulada x
meta, aging dos deals abertos, e as duas tabelas de Closers — Vendas,
Receita de Aquisição, Cross-Sell, Total, Ticket Médio, Taxa de Ganho, % da
Meta individual, e o funil SQL → Demo → SAL → Proposta → Ganho.

Duas descobertas direto no seu HubSpot tornaram isso possível:
- **Aquisição vs. Cross-Sell** = duas pipelines diferentes: `default`
  ("Gestão de Clínicas - Vendas") e `713767850` ("Gestão de Clínicas -
  Cross").
- **SQL / Demo / SAL / Proposta** não são métricas calculadas — são os
  próprios nomes dos estágios do funil de vendas, renomeados no HubSpot:
  `appointmentscheduled`=SQL, `qualifiedtobuy`=Demo Realizada,
  `presentationscheduled`=SAL, `decisionmakerboughtin`=Proposta Enviada.

⚠️ **Uma ressalva sobre o funil:** o HubSpot não nos dá aqui um histórico
de "em que data o deal entrou em cada etapa" — só o estágio atual. Então o
script conta "quantos deals estão numa etapa ou além dela hoje", o que é
uma boa aproximação mas não é idêntico a "quantos passaram por ali em
algum momento" (um deal que retrocedeu de etapa não conta duas vezes). Se
esse número divergir do que você via antes, provavelmente é por essa
diferença de metodologia — me avise que ajustamos juntos.

**O que ainda é manual:** só a coluna "Score Ativ." dos Closers, OKR Team,
Perfil de Cliente, SDR e Glossário. Não encontrei um campo de HubSpot
correspondente a "Score de Atividade" — preciso que você me diga a fonte
exata (outra ferramenta? uma conta de calls/e-mails/reuniões de um
período específico?) antes de automatizar.

---

## Passo a passo para publicar (uns 10 minutos)

### 1. Crie o repositório no GitHub
No github.com, clique em **New repository** → nome sugerido:
`amplimed-painel-vivo`.

⚠️ **Importante sobre privacidade:** no plano gratuito do GitHub, o GitHub
Pages só publica repositórios **públicos** — ou seja, qualquer pessoa com o
link do site (e, se olhar o "código fonte" da página, os números do
`data.json`) conseguiria ver. Não expõe nome de cliente nem dado de CRM,
só os números agregados de receita/pipeline/aging. Se isso for uma
preocupação, duas saídas:
- Assinar o **GitHub Pro** (baixo custo) para poder publicar Pages a partir
  de um repositório privado; ou
- Usar **Vercel/Netlify** no plano grátis, que permitem proteger o site com
  senha/allowlist mesmo em projetos gratuitos.

Se optar por manter simples, crie o repositório como **público** mesmo,
sabendo que só os números agregados do painel ficam visíveis publicamente
pelo link direto (ninguém encontra isso pesquisando, mas quem tiver o link
consegue acessar) → Create.

### 2. Suba estes arquivos
No seu computador, dentro da pasta que você baixou:
```bash
git init
git add .
git commit -m "primeira versão do painel vivo"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/amplimed-painel-vivo.git
git push -u origin main
```

### 3. Gere o token do HubSpot
No HubSpot: **Configurações → Integrações → Apps Privados → Criar app
privado**. Dê um nome (ex: "Painel Vivo"), na aba **Scopes** marque:
- `crm.objects.deals.read`
- `crm.objects.owners.read`

Clique em **Criar app** e copie o **Token de Acesso**. Guarde-o com
cuidado — ele dá acesso de leitura ao seu CRM.

### 4. Cadastre o token como Secret no GitHub
No repositório: **Settings → Secrets and variables → Actions → New
repository secret**.
- Nome: `HUBSPOT_TOKEN`
- Valor: cole o token do passo 3

*(Isso é o único lugar onde o token deve existir — nunca o coloque direto
em nenhum arquivo do projeto.)*

### 5. Ative o GitHub Pages
**Settings → Pages** → em "Build and deployment", Source: **Deploy from a
branch** → Branch: `main` / pasta `/ (root)` → Save.

Em 1–2 minutos o GitHub te dá a URL pública, algo como:
`https://SEU-USUARIO.github.io/amplimed-painel-vivo/`

### 6. Rode o robô pela primeira vez
No repositório: aba **Actions** → workflow "Atualizar dados do Painel
Amplimed" → **Run workflow** (botão à direita) → Run. Em ~30 segundos o
`data/data.json` é atualizado e comitado automaticamente.

Depois disso ele roda **sozinho, de hora em hora, das 7h às 19h**, sem
precisar fazer nada.

---

## Ajustes que você pode querer fazer

- **Meta do mês**: edite `monthlyGoal` em `config.json` sempre que a meta
  mudar, e comite.
- **Restringir a dias úteis**: no arquivo
  `.github/workflows/update-data.yml`, o cron `0 10-22 * * *` roda todo dia.
  Para rodar só de segunda a sábado, troque para `0 10-22 * * 1-6`.
- **Mudar o horário de corte**: troque `10-22` (UTC) — lembre que
  Brasília = UTC−3, então 7h–19h BRT = 10h–22h UTC.
## Testar localmente antes de subir

```bash
export HUBSPOT_TOKEN="seu_token_aqui"
node scripts/fetch-hubspot-data.js
# depois, para ver o painel:
python3 -m http.server 8000
# abra http://localhost:8000
```
