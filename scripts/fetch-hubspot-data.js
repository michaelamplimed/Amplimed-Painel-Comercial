/**
 * Amplimed — Painel Vivo
 * Busca dados reais no HubSpot (pipeline "default", deals de Clínicas/Consultórios)
 * e gera data/data.json, que o index.html lê no carregamento da página.
 *
 * Executado pelo GitHub Actions (.github/workflows/update-data.yml) de hora em
 * hora, das 7h às 19h (horário de Brasília), de segunda a sábado.
 *
 * Requer a variável de ambiente HUBSPOT_TOKEN (token de uma Private App do
 * HubSpot com escopo "crm.objects.deals.read" e "crm.objects.owners.read").
 * Nunca coloque o token direto no código — ele deve vir de um GitHub Secret.
 */

const fs = require('fs');
const path = require('path');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.error('ERRO: variável de ambiente HUBSPOT_TOKEN não definida.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const API_BASE = 'https://api.hubapi.com';

async function hubspotSearch(objectType, body) {
  const res = await fetch(`${API_BASE}/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchAllDeals(filterGroups, properties) {
  let results = [];
  let after = undefined;
  do {
    const body = { filterGroups, properties, limit: 100 };
    if (after) body.after = after;
    const page = await hubspotSearch('deals', body);
    results = results.concat(page.results || []);
    after = page.paging && page.paging.next ? page.paging.next.after : undefined;
  } while (after);
  return results;
}

// ── janela do mês corrente (America/Sao_Paulo) ────────────────────────────
function monthWindow() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  return { first, now };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function fmtDiaMes(d) {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

async function main() {
  const { first, now } = monthWindow();

  // 1) Deals ganhos (closedwon) com data de fechamento no mês corrente — Aquisição
  const wonDeals = await fetchAllDeals(
    [{
      filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: config.pipelineId },
        { propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' },
        { propertyName: 'closedate', operator: 'GTE', value: String(first.getTime()) }
      ]
    }],
    ['dealname', 'amount', 'closedate', 'hubspot_owner_id']
  );

  // 1b) Deals ganhos no funil de Cross-Sell (pipeline confirmada via amostragem no HubSpot)
  const crossSellDeals = config.crossSellPipelineId ? await fetchAllDeals(
    [{
      filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: config.crossSellPipelineId },
        { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' },
        { propertyName: 'closedate', operator: 'GTE', value: String(first.getTime()) }
      ]
    }],
    ['dealname', 'amount', 'closedate', 'hubspot_owner_id']
  ) : [];

  // 2) Deals perdidos (closedlost) no mês, para win rate
  const lostDeals = await fetchAllDeals(
    [{
      filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: config.pipelineId },
        { propertyName: 'dealstage', operator: 'EQ', value: 'closedlost' },
        { propertyName: 'closedate', operator: 'GTE', value: String(first.getTime()) }
      ]
    }],
    ['dealname', 'amount', 'closedate', 'hubspot_owner_id']
  );

  // 3) Deals abertos (pipeline ativo), para aging
  const openDeals = await fetchAllDeals(
    [{
      filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: config.pipelineId },
        { propertyName: 'dealstage', operator: 'NOT_IN', values: ['closedwon', 'closedlost'] }
      ]
    }],
    ['dealname', 'amount', 'createdate', 'hubspot_owner_id', 'dealstage']
  );

  // ── receita acumulada por dia do mês (Aquisição + Cross-Sell, como no total do topo) ──
  const dayCount = now.getDate();
  const dailyTotals = new Array(dayCount).fill(0);
  for (const d of [...wonDeals, ...crossSellDeals]) {
    const amount = parseFloat(d.properties.amount || '0') || 0;
    const closeDate = new Date(d.properties.closedate);
    const dayIdx = closeDate.getDate() - 1;
    if (dayIdx >= 0 && dayIdx < dayCount) dailyTotals[dayIdx] += amount;
  }
  const cumulative = [];
  let running = 0;
  for (let i = 0; i < dayCount; i++) {
    running += dailyTotals[i];
    cumulative.push(Math.round(running * 100) / 100);
  }
  const labels = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), i + 1);
    labels.push(fmtDiaMes(d));
  }

  const totalRealizado = cumulative[cumulative.length - 1] || 0;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const metaAcumulada = labels.map((_, i) => Math.round((config.monthlyGoal / daysInMonth) * (i + 1) * 100) / 100);
  const pctMeta = config.monthlyGoal > 0 ? Math.round((totalRealizado / config.monthlyGoal) * 1000) / 10 : 0;
  const mediaDiaria = Math.round((totalRealizado / dayCount) * 100) / 100;

  // ── pipeline aberto ────────────────────────────────────────────────────
  const pipelineAberto = openDeals.reduce((sum, d) => sum + (parseFloat(d.properties.amount || '0') || 0), 0);

  // ── aging (dias desde criação, deals abertos) ─────────────────────────
  const agingBuckets = { '0-7d': 0, '8-15d': 0, '16-30d': 0, '31-60d': 0, '+60d': 0 };
  for (const d of openDeals) {
    const created = new Date(d.properties.createdate);
    const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    if (ageDays <= 7) agingBuckets['0-7d']++;
    else if (ageDays <= 15) agingBuckets['8-15d']++;
    else if (ageDays <= 30) agingBuckets['16-30d']++;
    else if (ageDays <= 60) agingBuckets['31-60d']++;
    else agingBuckets['+60d']++;
  }

  // ── funil de conversão por etapa (SQL/Demo/SAL/Proposta), por closer ──
  // Nomes confirmados no HubSpot (get_properties > dealstage):
  //   appointmentscheduled = SQL · qualifiedtobuy = Demo Realizada
  //   presentationscheduled = SAL · decisionmakerboughtin = Proposta Enviada
  // Aproximação: o HubSpot não nos expõe aqui um histórico de "data de entrada
  // por etapa", então contamos deals cujo estágio ATUAL é aquela etapa ou uma
  // etapa posterior no funil (incluindo ganhos). É uma aproximação razoável,
  // não o número exato de "quantos passaram por ali em algum momento" — um
  // deal que retrocedeu de etapa não é recontado no estágio anterior.
  const STAGE_ORDER = ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin', 'contractsent', 'closedwon'];
  const allDefaultDeals = await fetchAllDeals(
    [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: config.pipelineId }] }],
    ['dealstage', 'hubspot_owner_id']
  );
  function reachedStage(deal, stageKey) {
    if (deal.properties.dealstage === 'closedwon') return true;
    const idx = STAGE_ORDER.indexOf(stageKey);
    const dealIdx = STAGE_ORDER.indexOf(deal.properties.dealstage);
    return dealIdx >= idx;
  }
  const funilPorCloser = {};
  for (const c of config.closers) {
    const deals = allDefaultDeals.filter(d => Number(d.properties.hubspot_owner_id) === c.ownerId);
    const sql = deals.filter(d => reachedStage(d, 'appointmentscheduled')).length;
    const demo = deals.filter(d => reachedStage(d, 'qualifiedtobuy')).length;
    const sal = deals.filter(d => reachedStage(d, 'presentationscheduled')).length;
    const proposta = deals.filter(d => reachedStage(d, 'decisionmakerboughtin')).length;
    const won = deals.filter(d => d.properties.dealstage === 'closedwon').length;
    const lost = deals.filter(d => d.properties.dealstage === 'closedlost').length;
    funilPorCloser[c.name] = {
      sql, demo, sal, proposta, won,
      sqlToDemoP: sql > 0 ? Math.round((demo / sql) * 1000) / 10 : null,
      demoToSalP: demo > 0 ? Math.round((sal / demo) * 1000) / 10 : null,
      salToPropP: sal > 0 ? Math.round((proposta / sal) * 1000) / 10 : null,
      winRateP: (won + lost) > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null
    };
  }


  const closerStats = config.closers.map(c => {
    const won = wonDeals.filter(d => Number(d.properties.hubspot_owner_id) === c.ownerId);
    const lost = lostDeals.filter(d => Number(d.properties.hubspot_owner_id) === c.ownerId);
    const cross = crossSellDeals.filter(d => Number(d.properties.hubspot_owner_id) === c.ownerId);
    const aquisicaoAmount = won.reduce((s, d) => s + (parseFloat(d.properties.amount || '0') || 0), 0);
    const crossSellAmount = cross.reduce((s, d) => s + (parseFloat(d.properties.amount || '0') || 0), 0);
    const totalAmount = aquisicaoAmount + crossSellAmount;
    const winRate = (won.length + lost.length) > 0 ? won.length / (won.length + lost.length) : 0;
    const metaMes = c.metaMes || 0;
    const diasNoMes = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const metaProRata = metaMes > 0 ? Math.round((metaMes / diasNoMes) * dayCount * 100) / 100 : 0;
    const funil = funilPorCloser[c.name] || {};
    return {
      name: c.name,
      nivel: c.nivel || null,
      ganhos: won.length,
      perdidos: lost.length,
      aquisicaoAmount: Math.round(aquisicaoAmount * 100) / 100,
      crossSellAmount: Math.round(crossSellAmount * 100) / 100,
      totalAmount: Math.round(totalAmount * 100) / 100,
      ticketMedio: won.length > 0 ? Math.round((totalAmount / won.length) * 100) / 100 : 0,
      winRate: Math.round(winRate * 1000) / 10,
      metaMes,
      metaProRata,
      pctMetaProRata: metaProRata > 0 ? Math.round((totalAmount / metaProRata) * 1000) / 10 : 0,
      funil
    };
  });

  const data = {
    geradoEm: now.toISOString(),
    geradoEmBR: now.toLocaleString('pt-BR', { timeZone: config.timezone }),
    mes: { ano: now.getFullYear(), mes: now.getMonth() + 1 },
    kpis: {
      receitaRealizada: Math.round(totalRealizado * 100) / 100,
      metaMensal: config.monthlyGoal,
      pctMeta,
      pipelineAberto: Math.round(pipelineAberto * 100) / 100,
      mediaDiaria
    },
    receitaAcumulada: { labels, realizado: cumulative, meta: metaAcumulada },
    aging: agingBuckets,
    closers: closerStats
  };

  const outPath = path.join(__dirname, '..', 'data', 'data.json');
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`data.json atualizado em ${data.geradoEmBR} — ${wonDeals.length} ganhos, ${openDeals.length} abertos.`);
}

main().catch(err => {
  console.error('Falha ao gerar data.json:', err);
  process.exit(1);
});
