/**
 * Amplimed — Painel Vivo
 *
 * Busca dados reais no HubSpot e gera data/data.json.
 *
 * Atualização:
 * - GitHub Actions executa a cada 30 minutos.
 * - O mês é identificado automaticamente pelo horário de Brasília.
 * - As metas mensais são lidas do config.json.
 * - Não é necessário alterar o código na virada do mês.
 *
 * Requer:
 * HUBSPOT_TOKEN
 *
 * Nunca coloque o token diretamente neste arquivo.
 */

const fs = require('fs');
const path = require('path');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

if (!HUBSPOT_TOKEN) {
  console.error('ERRO: variável de ambiente HUBSPOT_TOKEN não definida.');
  process.exit(1);
}

const config = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'config.json'),
    'utf8'
  )
);

const API_BASE = 'https://api.hubapi.com';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retorna a data atual no timezone configurado.
 */
function getNowInTimezone() {
  const timezone = config.timezone || 'America/Sao_Paulo';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

/**
 * Chave do mês no formato YYYY-MM.
 */
function getCurrentMonthKey() {
  const now = getNowInTimezone();

  return `${now.year}-${String(now.month).padStart(2, '0')}`;
}

/**
 * Data/hora atual real.
 */
function getCurrentDate() {
  return new Date();
}

/**
 * Executa pesquisa no HubSpot com retry.
 */
async function hubspotSearch(objectType, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(
      `${API_BASE}/crm/v3/objects/${objectType}/search`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (res.ok) {
      return res.json();
    }

    const text = await res.text();

    if (
      (res.status === 429 || res.status >= 500) &&
      attempt < retries
    ) {
      const delay = attempt * 3000;

      console.log(
        `HubSpot API ${res.status} ` +
        `(tentativa ${attempt}/${retries}) — ` +
        `aguardando ${delay / 1000}s...`
      );

      await sleep(delay);
      continue;
    }

    throw new Error(
      `HubSpot API ${res.status}: ${text}`
    );
  }
}

/**
 * Busca todos os deals respeitando a paginação.
 */
async function fetchAllDeals(filterGroups, properties) {
  let results = [];
  let after = undefined;
  let pageNum = 0;

  do {
    if (pageNum > 0) {
      await sleep(400);
    }

    const body = {
      filterGroups,
      properties,
      limit: 100
    };

    if (after) {
      body.after = after;
    }

    const page = await hubspotSearch(
      'deals',
      body
    );

    results = results.concat(
      page.results || []
    );

    after =
      page.paging &&
      page.paging.next
        ? page.paging.next.after
        : undefined;

    pageNum++;

  } while (after);

  return results;
}

/**
 * Retorna o primeiro instante do mês corrente
 * no timezone de Brasília, convertido para timestamp.
 *
 * O runner do GitHub usa UTC, por isso não podemos
 * simplesmente usar new Date(year, month, 1).
 */
function getMonthStartTimestamp() {
  const now = getNowInTimezone();

  const utcDate = new Date(
    Date.UTC(
      now.year,
      now.month - 1,
      1,
      3,
      0,
      0,
      0
    )
  );

  return utcDate.getTime();
}

/**
 * Formata dia/mês para o painel.
 */
function fmtDiaMes(year, month, day) {
  const d = new Date(
    Date.UTC(year, month - 1, day)
  );

  return d.toLocaleDateString(
    'pt-BR',
    {
      day: '2-digit',
      month: '2-digit',
      timeZone: 'UTC'
    }
  );
}

/**
 * Retorna quantidade de dias do mês.
 */
function getDaysInMonth(year, month) {
  return new Date(
    Date.UTC(year, month, 0)
  ).getUTCDate();
}

/**
 * Retorna a meta geral do mês atual.
 */
function getCurrentMonthlyGoals() {
  const monthKey = getCurrentMonthKey();

  const goals = config.metasMensais?.[monthKey];

  if (!goals) {
    throw new Error(
      `ERRO: não existe meta configurada para ${monthKey} no config.json.`
    );
  }

  return {
    monthKey,
    closer: Number(goals.closer || 0),
    sdr: Number(goals.sdr || 0)
  };
}

/**
 * Calcula a meta individual dos closers.
 *
 * Agosto é a base atualmente cadastrada no config.
 * Nos demais meses, a meta individual é distribuída
 * proporcionalmente ao peso de cada closer na base.
 *
 * Isso mantém a proporção atual sem precisar editar
 * o código na virada do mês.
 */
function getIndividualGoal(role, name, monthKey) {
  const table =
    config.metasIndividuais &&
    config.metasIndividuais[role];

  const monthTable = table && table[monthKey];

  if (!monthTable || !(name in monthTable)) {
    console.warn(
      `AVISO: meta individual não cadastrada para ${role}/${name} em ${monthKey} ` +
      `(config.metasIndividuais.${role}.${monthKey}). Usando 0 — verifique o config.json.`
    );
    return 0;
  }

  return Number(monthTable[name] || 0);
}

async function main() {

  const nowReal = getCurrentDate();
  const nowBR = getNowInTimezone();

  const currentGoals =
    getCurrentMonthlyGoals();

  const monthKey =
    currentGoals.monthKey;

  const firstTimestamp =
    getMonthStartTimestamp();

  const year =
    nowBR.year;

  const month =
    nowBR.month;

  const dayCount =
    nowBR.day;

  const daysInMonth =
    getDaysInMonth(year, month);

  console.log(
    `Mês atual: ${monthKey}`
  );

  console.log(
    `Meta Closer: R$ ${currentGoals.closer.toLocaleString('pt-BR')}`
  );

  console.log(
    `Meta SDR: R$ ${currentGoals.sdr.toLocaleString('pt-BR')}`
  );

  const DEAL_PROPS_CLOSED = [
    'dealname',
    'amount',
    'closedate',
    'hubspot_owner_id',
    'dealstage',
    'sdr_do_negocio',
    'closer_do_negocio'
  ];

  // ==========================================================
  // 1. DEALS GANHOS — AQUISIÇÃO
  // ==========================================================

  const wonDeals =
    await fetchAllDeals(
      [{
        filters: [
          {
            propertyName: 'pipeline',
            operator: 'EQ',
            value: config.pipelineId
          },
          {
            propertyName: 'dealstage',
            operator: 'EQ',
            value: 'closedwon'
          },
          {
            propertyName: 'closedate',
            operator: 'GTE',
            value: String(firstTimestamp)
          }
        ]
      }],
      DEAL_PROPS_CLOSED
    );

  await sleep(500);

  // ==========================================================
  // 2. DEALS GANHOS — CROSS SELL
  // ==========================================================

  const crossSellDeals =
    config.crossSellPipelineId
      ? await fetchAllDeals(
          [{
            filters: [
              {
                propertyName: 'pipeline',
                operator: 'EQ',
                value: config.crossSellPipelineId
              },
              {
                propertyName: 'dealstage',
                operator: 'EQ',
                value: '1041958423'
              },
              {
                propertyName: 'closedate',
                operator: 'GTE',
                value: String(firstTimestamp)
              }
            ]
          }],
          DEAL_PROPS_CLOSED
        )
      : [];

  await sleep(500);

  // ==========================================================
  // 3. DEALS PERDIDOS
  // ==========================================================

  const lostDeals =
    await fetchAllDeals(
      [{
        filters: [
          {
            propertyName: 'pipeline',
            operator: 'EQ',
            value: config.pipelineId
          },
          {
            propertyName: 'dealstage',
            operator: 'EQ',
            value: 'closedlost'
          },
          {
            propertyName: 'closedate',
            operator: 'GTE',
            value: String(firstTimestamp)
          }
        ]
      }],
      DEAL_PROPS_CLOSED
    );

  await sleep(500);

  // ==========================================================
  // 4. DEALS ABERTOS
  // ==========================================================

  const openDeals =
    await fetchAllDeals(
      [{
        filters: [
          {
            propertyName: 'pipeline',
            operator: 'EQ',
            value: config.pipelineId
          },
          {
            propertyName: 'dealstage',
            operator: 'NOT_IN',
            values: [
              'closedwon',
              'closedlost'
            ]
          }
        ]
      }],
      [
        'dealname',
        'amount',
        'createdate',
        'hubspot_owner_id',
        'dealstage'
      ]
    );

  await sleep(500);

  // ==========================================================
  // 5. DEALS QUE ENTRARAM EM SQL ESTE MÊS (para contagem por SDR)
  // ==========================================================
  // Espelha o relatório "Placar - Ranking SDR (Mês Atual)" do HubSpot,
  // mas contando entradas em SQL em vez de somar receita.

  const sqlDeals =
    await fetchAllDeals(
      [{
        filters: [
          {
            propertyName: 'pipeline',
            operator: 'EQ',
            value: config.pipelineId
          },
          {
            propertyName: 'data_de_entrada_em_sql',
            operator: 'GTE',
            value: String(firstTimestamp)
          }
        ]
      }],
      [
        'dealname',
        'sdr_do_negocio',
        'data_de_entrada_em_sql'
      ]
    );

  // ==========================================================
  // FUNIL
  // ==========================================================

  const allDefaultDeals = [
    ...openDeals,
    ...wonDeals,
    ...lostDeals
  ];

  // ==========================================================
  // RECEITA ACUMULADA POR DIA
  // ==========================================================

  const dailyTotals =
    new Array(dayCount).fill(0);

  for (
    const d of [
      ...wonDeals,
      ...crossSellDeals
    ]
  ) {

    const amount =
      parseFloat(
        d.properties.amount || '0'
      ) || 0;

    const closeDate =
      new Date(
        d.properties.closedate
      );

    const closeBRParts =
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            config.timezone ||
            'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }
      ).formatToParts(closeDate);

    const closeBR = {};

    for (
      const part of closeBRParts
    ) {
      if (part.type !== 'literal') {
        closeBR[part.type] =
          part.value;
      }
    }

    const closeYear =
      Number(closeBR.year);

    const closeMonth =
      Number(closeBR.month);

    const closeDay =
      Number(closeBR.day);

    if (
      closeYear === year &&
      closeMonth === month &&
      closeDay >= 1 &&
      closeDay <= dayCount
    ) {
      dailyTotals[
        closeDay - 1
      ] += amount;
    }
  }

  const cumulative = [];

  let running = 0;

  for (
    let i = 0;
    i < dayCount;
    i++
  ) {
    running +=
      dailyTotals[i];

    cumulative.push(
      Math.round(
        running * 100
      ) / 100
    );
  }

  const labels = [];

  for (
    let i = 0;
    i < dayCount;
    i++
  ) {
    labels.push(
      fmtDiaMes(
        year,
        month,
        i + 1
      )
    );
  }

  const totalRealizado =
    cumulative[
      cumulative.length - 1
    ] || 0;

  const metaAcumulada =
    labels.map(
      (_, i) =>
        Math.round(
          (
            currentGoals.closer /
            daysInMonth *
            (i + 1)
          ) * 100
        ) / 100
    );

  const pctMeta =
    currentGoals.closer > 0
      ? Math.round(
          (
            totalRealizado /
            currentGoals.closer
          ) * 1000
        ) / 10
      : 0;

  const mediaDiaria =
    dayCount > 0
      ? Math.round(
          (
            totalRealizado /
            dayCount
          ) * 100
        ) / 100
      : 0;

  // ==========================================================
  // PIPELINE ABERTO
  // ==========================================================

  const pipelineAberto =
    openDeals.reduce(
      (
        sum,
        d
      ) =>
        sum +
        (
          parseFloat(
            d.properties.amount || '0'
          ) || 0
        ),
      0
    );

  // ==========================================================
  // AGING
  // ==========================================================

  const agingBuckets = {
    '0-7d': 0,
    '8-15d': 0,
    '16-30d': 0,
    '31-60d': 0,
    '+60d': 0
  };

  for (
    const d of openDeals
  ) {

    const created =
      new Date(
        d.properties.createdate
      );

    const ageDays =
      Math.floor(
        (
          nowReal -
          created
        ) /
        (
          1000 *
          60 *
          60 *
          24
        )
      );

    if (
      ageDays <= 7
    ) {
      agingBuckets['0-7d']++;
    } else if (
      ageDays <= 15
    ) {
      agingBuckets['8-15d']++;
    } else if (
      ageDays <= 30
    ) {
      agingBuckets['16-30d']++;
    } else if (
      ageDays <= 60
    ) {
      agingBuckets['31-60d']++;
    } else {
      agingBuckets['+60d']++;
    }
  }

  // ==========================================================
  // FUNIL DE CONVERSÃO
  // ==========================================================

  const STAGE_ORDER = [
    'appointmentscheduled',
    'qualifiedtobuy',
    'presentationscheduled',
    'decisionmakerboughtin',
    'contractsent',
    'closedwon'
  ];

  function reachedStage(
    deal,
    stageKey
  ) {

    if (
      deal.properties.dealstage ===
      'closedwon'
    ) {
      return true;
    }

    const idx =
      STAGE_ORDER.indexOf(
        stageKey
      );

    const dealIdx =
      STAGE_ORDER.indexOf(
        deal.properties.dealstage
      );

    return (
      dealIdx >= idx
    );
  }

  const funilPorCloser = {};

  for (
    const c of config.closers
  ) {

    const deals =
      allDefaultDeals.filter(
        d =>
          Number(
            d.properties
              .hubspot_owner_id
          ) ===
          c.ownerId
      );

    const sql =
      deals.filter(
        d =>
          reachedStage(
            d,
            'appointmentscheduled'
          )
      ).length;

    const demo =
      deals.filter(
        d =>
          reachedStage(
            d,
            'qualifiedtobuy'
          )
      ).length;

    const sal =
      deals.filter(
        d =>
          reachedStage(
            d,
            'presentationscheduled'
          )
      ).length;

    const proposta =
      deals.filter(
        d =>
          reachedStage(
            d,
            'decisionmakerboughtin'
          )
      ).length;

    const won =
      deals.filter(
        d =>
          d.properties.dealstage ===
          'closedwon'
      ).length;

    const lost =
      deals.filter(
        d =>
          d.properties.dealstage ===
          'closedlost'
      ).length;

    funilPorCloser[c.name] = {
      sql,
      demo,
      sal,
      proposta,
      won,

      sqlToDemoP:
        sql > 0
          ? Math.round(
              (
                demo /
                sql
              ) * 1000
            ) / 10
          : null,

      demoToSalP:
        demo > 0
          ? Math.round(
              (
                sal /
                demo
              ) * 1000
            ) / 10
          : null,

      salToPropP:
        sal > 0
          ? Math.round(
              (
                proposta /
                sal
              ) * 1000
            ) / 10
          : null,

      winRateP:
        (
          won + lost
        ) > 0
          ? Math.round(
              (
                won /
                (
                  won +
                  lost
                )
              ) * 1000
            ) / 10
          : null
    };
  }

  // ==========================================================
  // ESTATÍSTICAS POR CLOSER
  // ==========================================================

  const closerStats =
    config.closers.map(
      c => {

        // Agrupamento por "Closer do Negócio" (closer_do_negocio),
        // mesmo campo/dimensão usado no relatório oficial "Placar - Ranking
        // Closers (Mês Atual)" do HubSpot — não pelo dono padrão do negócio
        // (hubspot_owner_id), que pode divergir do closer que realmente atuou.
        const won =
          wonDeals.filter(
            d =>
              Number(
                d.properties
                  .closer_do_negocio
              ) ===
              c.ownerId
          );

        const lost =
          lostDeals.filter(
            d =>
              Number(
                d.properties
                  .closer_do_negocio
              ) ===
              c.ownerId
          );

        const cross =
          crossSellDeals.filter(
            d =>
              Number(
                d.properties
                  .closer_do_negocio
              ) ===
              c.ownerId
          );

        const aquisicaoAmount =
          won.reduce(
            (
              s,
              d
            ) =>
              s +
              (
                parseFloat(
                  d.properties.amount ||
                  '0'
                ) || 0
              ),
            0
          );

        const crossSellAmount =
          cross.reduce(
            (
              s,
              d
            ) =>
              s +
              (
                parseFloat(
                  d.properties.amount ||
                  '0'
                ) || 0
              ),
            0
          );

        const totalAmount =
          aquisicaoAmount +
          crossSellAmount;

        const winRate =
          (
            won.length +
            lost.length
          ) > 0
            ? won.length /
              (
                won.length +
                lost.length
              )
            : 0;

        const metaMes =
          getIndividualGoal(
            'closers',
            c.name,
            monthKey
          );

        const metaProRata =
          metaMes > 0
            ? Math.round(
                (
                  metaMes /
                  daysInMonth *
                  dayCount
                ) * 100
              ) / 100
            : 0;

        const funil =
          funilPorCloser[
            c.name
          ] || {};

        return {
          name: c.name,

          nivel:
            c.nivel ||
            null,

          ganhos:
            won.length,

          perdidos:
            lost.length,

          crossSellGanhos:
            cross.length,

          aquisicaoAmount:
            Math.round(
              aquisicaoAmount *
              100
            ) / 100,

          crossSellAmount:
            Math.round(
              crossSellAmount *
              100
            ) / 100,

          totalAmount:
            Math.round(
              totalAmount *
              100
            ) / 100,

          ticketMedio:
            won.length > 0
              ? Math.round(
                  (
                    totalAmount /
                    won.length
                  ) * 100
                ) / 100
              : 0,

          winRate:
            Math.round(
              winRate *
              1000
            ) / 10,

          metaMes,

          metaProRata,

          pctMetaProRata:
            metaProRata > 0
              ? Math.round(
                  (
                    totalAmount /
                    metaProRata
                  ) * 1000
                ) / 10
              : 0,

          funil
        };
      }
    );

  // ==========================================================
  // ESTATÍSTICAS POR SDR
  // ==========================================================
  // Espelha o relatório "Placar - Ranking SDR (Mês Atual)" do HubSpot:
  // receita influenciada = soma de deals ganhos (aquisição + cross-sell)
  // filtrados pelo campo "SDR do Negócio" (sdr_do_negocio).
  // SQL = quantidade de deals que entraram em SQL este mês, mesmo campo.

  const sdrStats =
    (config.sdrs || []).map(
      s => {

        const wonPorSdr =
          wonDeals.filter(
            d =>
              Number(
                d.properties
                  .sdr_do_negocio
              ) === s.ownerId
          );

        const crossPorSdr =
          crossSellDeals.filter(
            d =>
              Number(
                d.properties
                  .sdr_do_negocio
              ) === s.ownerId
          );

        const sqlPorSdr =
          sqlDeals.filter(
            d =>
              Number(
                d.properties
                  .sdr_do_negocio
              ) === s.ownerId
          );

        const recAquisicao =
          wonPorSdr.reduce(
            (sum, d) =>
              sum +
              (parseFloat(d.properties.amount || '0') || 0),
            0
          );

        const recCross =
          crossPorSdr.reduce(
            (sum, d) =>
              sum +
              (parseFloat(d.properties.amount || '0') || 0),
            0
          );

        const recInfluenciada =
          recAquisicao + recCross;

        const metaMes =
          getIndividualGoal(
            'sdrs',
            s.name,
            monthKey
          );

        const metaProRata =
          metaMes > 0
            ? Math.round(
                (metaMes / daysInMonth * dayCount) * 100
              ) / 100
            : 0;

        return {
          name: s.name,

          sql: sqlPorSdr.length,

          recInfluenciada:
            Math.round(recInfluenciada * 100) / 100,

          metaMes,

          metaProRata,

          pctMetaProRata:
            metaProRata > 0
              ? Math.round(
                  (recInfluenciada / metaProRata) * 1000
                ) / 10
              : 0
        };
      }
    );

  // ==========================================================
  // DATA.JSON
  // ==========================================================

  const data = {

    geradoEm:
      nowReal.toISOString(),

    geradoEmBR:
      nowReal.toLocaleString(
        'pt-BR',
        {
          timeZone:
            config.timezone ||
            'America/Sao_Paulo'
        }
      ),

    mes: {
      ano: year,
      mes: month,
      chave: monthKey
    },

    metas: {
      closer:
        currentGoals.closer,

      sdr:
        currentGoals.sdr
    },

    kpis: {

      receitaRealizada:
        Math.round(
          totalRealizado *
          100
        ) / 100,

      metaMensal:
        currentGoals.closer,

      pctMeta,

      pipelineAberto:
        Math.round(
          pipelineAberto *
          100
        ) / 100,

      mediaDiaria
    },

    receitaAcumulada: {
      labels,
      realizado:
        cumulative,
      meta:
        metaAcumulada
    },

    aging:
      agingBuckets,

    closers:
      closerStats,

    sdrs:
      sdrStats
  };

  const outPath =
    path.join(
      __dirname,
      '..',
      'data',
      'data.json'
    );

  fs.writeFileSync(
    outPath,
    JSON.stringify(
      data,
      null,
      2
    )
  );

  console.log(
    `data.json atualizado em ${data.geradoEmBR}`
  );

  console.log(
    `Mês: ${monthKey}`
  );

  console.log(
    `Meta Closer: R$ ${currentGoals.closer.toLocaleString('pt-BR')}`
  );

  console.log(
    `Meta SDR: R$ ${currentGoals.sdr.toLocaleString('pt-BR')}`
  );

  console.log(
    `Ganhos: ${wonDeals.length}`
  );

  console.log(
    `Abertos: ${openDeals.length}`
  );
}

main().catch(
  err => {
    console.error(
      'Falha ao gerar data.json:',
      err
    );

    process.exit(1);
  }
);
