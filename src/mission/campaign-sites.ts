/**
 * Launch sites per campaign mission: for every site of the launch-site table
 * (data/launch-sites.json), whether the mission is offered from it, with that
 * site's reference solution (total delta-v, m/s, of which the ascent; mission
 * time, s) and limits, or why not. Plain data, shown by the game and the
 * leaderboard.
 *
 * WHERE THE NUMBERS COME FROM (version 4: launch vehicles). Each offered
 * (mission, site) pair was solved on the mission's launch vehicle with the
 * planning aids (test/mission-campaign-sites-solve.test.ts, SLOW=1: parking
 * altitude chosen with the ascent model, the departure flown by the upper
 * stage and split across a separation when it runs short). The plans are kept
 * in test/fixtures/campaign-solutions.json and flown by
 * test/mission-campaign-sites.test.ts (interplanetary ones with SLOW=1). Each
 * mission's par is its best site's reference (parSite; plane-change: the Cape,
 * its subject). References are evidence that the mission is achievable from
 * the site, not optima: they drop the upper stage ten minutes after the
 * departure with what it has left, which a player may use.
 *
 * LIMITS per site, from that site's reference: delta-v = ascent + flight x
 * 1.08, rounded up to 10 m/s (the three sample missions: their original ratio
 * of limit to par, on the flight); time x 1.25 rounded up to 10 minutes near
 * Earth, x 1.15 rounded up to the day for interplanetary missions (the samples
 * keep their flat time limits); never above the mission's maxDuration.
 *
 * NOT OFFERED. plane-change from every site but the Cape: its lesson is the
 * Cape corridor's 60° ceiling, and every other site reaches 64-66° directly.
 * geo-from-leo from Vandenberg: its corridor's lowest inclination (~56°) costs
 * more to remove at apogee than the vehicle and satellite carry. Every other
 * mission is offered from all seven sites.
 */
import type { SiteOption } from './objectives';

const DAY = 86400;
const HOUR = 3600;

export const CAMPAIGN_SITES: Readonly<Record<string, readonly SiteOption[]>> = {
  'plane-change': [
    { site: 'cape-canaveral', offered: true, deltaV: 10065.6, ascentDeltaV: 9295.0, time: 21870, maxDeltaV: 10130, maxTime: 27600 },
    { site: 'vandenberg', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'kourou', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'baikonur', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'tanegashima', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'mahia', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'equator', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
  ],
  'geo-from-leo': [
    { site: 'cape-canaveral', offered: true, deltaV: 13719.4, ascentDeltaV: 9362.3, time: 301636, maxDeltaV: 14350, maxTime: 6 * DAY },
    { site: 'vandenberg', offered: false, reason: 'its corridor’s lowest inclination is about 56°: removing that at apogee costs more than the Ariane’s upper stage and the satellite carry together' },
    { site: 'kourou', offered: true, deltaV: 13277.4, ascentDeltaV: 9297.6, time: 321188, maxDeltaV: 13860, maxTime: 6 * DAY },
    { site: 'baikonur', offered: true, deltaV: 14506.2, ascentDeltaV: 9504.5, time: 280889, maxDeltaV: 15230, maxTime: 6 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 13759.5, ascentDeltaV: 9370.8, time: 324456, maxDeltaV: 14400, maxTime: 6 * DAY },
    { site: 'mahia', offered: true, deltaV: 14064.7, ascentDeltaV: 9423.4, time: 283221, maxDeltaV: 14740, maxTime: 6 * DAY },
    { site: 'equator', offered: true, deltaV: 13259.4, ascentDeltaV: 9295.7, time: 280168, maxDeltaV: 13840, maxTime: 6 * DAY },
  ],
  'earth-escape': [
    { site: 'cape-canaveral', offered: true, deltaV: 12656.1, ascentDeltaV: 9010.2, time: 223565, maxDeltaV: 12950, maxTime: 279600 },
    { site: 'vandenberg', offered: true, deltaV: 12904.0, ascentDeltaV: 9250.9, time: 158550, maxDeltaV: 13200, maxTime: 198600 },
    { site: 'kourou', offered: true, deltaV: 12594.8, ascentDeltaV: 8951.1, time: 259811, maxDeltaV: 12890, maxTime: 325200 },
    { site: 'baikonur', offered: true, deltaV: 12798.2, ascentDeltaV: 9147.2, time: 177384, maxDeltaV: 13100, maxTime: 222000 },
    { site: 'tanegashima', offered: true, deltaV: 12666.7, ascentDeltaV: 9020.9, time: 218525, maxDeltaV: 12960, maxTime: 273600 },
    { site: 'mahia', offered: true, deltaV: 12710.7, ascentDeltaV: 9063.5, time: 201285, maxDeltaV: 13010, maxTime: 252000 },
    { site: 'equator', offered: true, deltaV: 12589.5, ascentDeltaV: 8948.7, time: 261698, maxDeltaV: 12890, maxTime: 327600 },
  ],
  'lunar-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 12161.5, ascentDeltaV: 9023.9, time: 378383, maxDeltaV: 12500, maxTime: 7 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 12389.8, ascentDeltaV: 9244.7, time: 319447, maxDeltaV: 12730, maxTime: 7 * DAY },
    { site: 'kourou', offered: true, deltaV: 12156.3, ascentDeltaV: 9018.9, time: 392477, maxDeltaV: 12490, maxTime: 7 * DAY },
    { site: 'baikonur', offered: true, deltaV: 12289.8, ascentDeltaV: 9143.7, time: 315287, maxDeltaV: 12630, maxTime: 7 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 12176.7, ascentDeltaV: 9032.6, time: 312475, maxDeltaV: 12510, maxTime: 7 * DAY },
    { site: 'mahia', offered: true, deltaV: 12224.6, ascentDeltaV: 9079.6, time: 319545, maxDeltaV: 12560, maxTime: 7 * DAY },
    { site: 'equator', offered: true, deltaV: 12155.3, ascentDeltaV: 9017.3, time: 383120, maxDeltaV: 12490, maxTime: 7 * DAY },
  ],
  'lunar-free-return': [
    { site: 'cape-canaveral', offered: true, deltaV: 12186.5, ascentDeltaV: 9023.9, time: 622093, maxDeltaV: 12320, maxTime: 12 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 12394.8, ascentDeltaV: 9244.7, time: 747573, maxDeltaV: 12530, maxTime: 12 * DAY },
    { site: 'kourou', offered: true, deltaV: 12181.3, ascentDeltaV: 9018.9, time: 599590, maxDeltaV: 12320, maxTime: 12 * DAY },
    { site: 'baikonur', offered: true, deltaV: 12294.8, ascentDeltaV: 9143.7, time: 680248, maxDeltaV: 12430, maxTime: 12 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 12181.7, ascentDeltaV: 9032.6, time: 751581, maxDeltaV: 12320, maxTime: 12 * DAY },
    { site: 'mahia', offered: true, deltaV: 12229.6, ascentDeltaV: 9079.6, time: 594163, maxDeltaV: 12370, maxTime: 12 * DAY },
    { site: 'equator', offered: true, deltaV: 12185.3, ascentDeltaV: 9017.3, time: 531880, maxDeltaV: 12320, maxTime: 12 * DAY },
  ],
  'lunar-orbit': [
    { site: 'cape-canaveral', offered: true, deltaV: 13243.4, ascentDeltaV: 9329.0, time: 293838, maxDeltaV: 13560, maxTime: 367800 },
    { site: 'vandenberg', offered: true, deltaV: 13369.4, ascentDeltaV: 9563.7, time: 378561, maxDeltaV: 13680, maxTime: 473400 },
    { site: 'kourou', offered: true, deltaV: 13485.1, ascentDeltaV: 9323.6, time: 255654, maxDeltaV: 13820, maxTime: 319800 },
    { site: 'baikonur', offered: true, deltaV: 13257.4, ascentDeltaV: 9457.5, time: 375541, maxDeltaV: 13570, maxTime: 469800 },
    { site: 'tanegashima', offered: true, deltaV: 13107.9, ascentDeltaV: 9338.3, time: 376852, maxDeltaV: 13410, maxTime: 471600 },
    { site: 'mahia', offered: true, deltaV: 13149.9, ascentDeltaV: 9384.4, time: 354569, maxDeltaV: 13460, maxTime: 443400 },
    { site: 'equator', offered: true, deltaV: 13561.1, ascentDeltaV: 9323.7, time: 245977, maxDeltaV: 13910, maxTime: 307800 },
  ],
  'venus-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 13333.1, ascentDeltaV: 9679.2, time: 14901507, maxDeltaV: 13630, maxTime: 199 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 13913.6, ascentDeltaV: 10095.7, time: 14873103, maxDeltaV: 14220, maxTime: 198 * DAY },
    { site: 'kourou', offered: true, deltaV: 13341.2, ascentDeltaV: 9681.9, time: 14938837, maxDeltaV: 13640, maxTime: 199 * DAY },
    { site: 'baikonur', offered: true, deltaV: 13726.9, ascentDeltaV: 9855.3, time: 14945793, maxDeltaV: 14040, maxTime: 199 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 13284.5, ascentDeltaV: 9637.8, time: 14873941, maxDeltaV: 13580, maxTime: 198 * DAY },
    { site: 'mahia', offered: true, deltaV: 13380.6, ascentDeltaV: 9696.7, time: 14921907, maxDeltaV: 13680, maxTime: 199 * DAY },
    { site: 'equator', offered: true, deltaV: 13337.1, ascentDeltaV: 9682.0, time: 14910035, maxDeltaV: 13630, maxTime: 199 * DAY },
  ],
  'mars-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 12652.2, ascentDeltaV: 9009.0, time: 27331347, maxDeltaV: 12950, maxTime: 364 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 13148.7, ascentDeltaV: 9229.0, time: 27383479, maxDeltaV: 13470, maxTime: 365 * DAY },
    { site: 'kourou', offered: true, deltaV: 12659.6, ascentDeltaV: 9011.8, time: 27358595, maxDeltaV: 12960, maxTime: 365 * DAY },
    { site: 'baikonur', offered: true, deltaV: 12933.6, ascentDeltaV: 9131.8, time: 27363644, maxDeltaV: 13240, maxTime: 365 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 12704.5, ascentDeltaV: 9017.6, time: 27375874, maxDeltaV: 13000, maxTime: 365 * DAY },
    { site: 'mahia', offered: true, deltaV: 12764.2, ascentDeltaV: 9064.4, time: 27340869, maxDeltaV: 13070, maxTime: 364 * DAY },
    { site: 'equator', offered: true, deltaV: 12654.6, ascentDeltaV: 9011.9, time: 27332808, maxDeltaV: 12950, maxTime: 364 * DAY },
  ],
  'mars-orbit': [
    { site: 'cape-canaveral', offered: true, deltaV: 13868.2, ascentDeltaV: 9010.1, time: 26068350, maxDeltaV: 14260, maxTime: 347 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 14315.5, ascentDeltaV: 9231.4, time: 26120879, maxDeltaV: 14730, maxTime: 348 * DAY },
    { site: 'kourou', offered: true, deltaV: 13873.9, ascentDeltaV: 9013.0, time: 26099250, maxDeltaV: 14270, maxTime: 348 * DAY },
    { site: 'baikonur', offered: true, deltaV: 14168.4, ascentDeltaV: 9135.5, time: 26106534, maxDeltaV: 14580, maxTime: 348 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 13921.1, ascentDeltaV: 9019.6, time: 26110462, maxDeltaV: 14320, maxTime: 348 * DAY },
    { site: 'mahia', offered: true, deltaV: 13977.7, ascentDeltaV: 9065.2, time: 26077970, maxDeltaV: 14380, maxTime: 348 * DAY },
    { site: 'equator', offered: true, deltaV: 13871.1, ascentDeltaV: 9013.8, time: 26070641, maxDeltaV: 14260, maxTime: 348 * DAY },
  ],
  'venus-to-mercury': [
    { site: 'cape-canaveral', offered: true, deltaV: 14522.5, ascentDeltaV: 9416.1, time: 28963759, maxDeltaV: 14940, maxTime: 386 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 14908.6, ascentDeltaV: 9756.1, time: 28943120, maxDeltaV: 15330, maxTime: 386 * DAY },
    { site: 'kourou', offered: true, deltaV: 14419.1, ascentDeltaV: 9350.8, time: 28976081, maxDeltaV: 14830, maxTime: 386 * DAY },
    { site: 'baikonur', offered: true, deltaV: 14680.5, ascentDeltaV: 9596.4, time: 28927692, maxDeltaV: 15090, maxTime: 386 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 14502.0, ascentDeltaV: 9422.0, time: 28927110, maxDeltaV: 14910, maxTime: 386 * DAY },
    { site: 'mahia', offered: true, deltaV: 14662.4, ascentDeltaV: 9517.4, time: 28983025, maxDeltaV: 15080, maxTime: 386 * DAY },
    { site: 'equator', offered: true, deltaV: 14417.6, ascentDeltaV: 9337.4, time: 28956240, maxDeltaV: 14830, maxTime: 386 * DAY },
  ],
  'solar-escape': [
    { site: 'cape-canaveral', offered: true, deltaV: 16470.2, ascentDeltaV: 9351.1, time: 71779226, maxDeltaV: 17040, maxTime: 956 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 16658.2, ascentDeltaV: 9576.8, time: 71774032, maxDeltaV: 17230, maxTime: 956 * DAY },
    { site: 'kourou', offered: true, deltaV: 16463.7, ascentDeltaV: 9352.7, time: 71726932, maxDeltaV: 17040, maxTime: 955 * DAY },
    { site: 'baikonur', offered: true, deltaV: 16569.6, ascentDeltaV: 9472.6, time: 71754379, maxDeltaV: 17140, maxTime: 956 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 16461.9, ascentDeltaV: 9348.7, time: 71745635, maxDeltaV: 17040, maxTime: 955 * DAY },
    { site: 'mahia', offered: true, deltaV: 16486.3, ascentDeltaV: 9390.1, time: 71721931, maxDeltaV: 17060, maxTime: 955 * DAY },
    { site: 'equator', offered: true, deltaV: 16464.2, ascentDeltaV: 9350.8, time: 71741529, maxDeltaV: 17040, maxTime: 955 * DAY },
  ],
  'jupiter-saturn': [
    { site: 'cape-canaveral', offered: true, deltaV: 16541.7, ascentDeltaV: 9335.8, time: 201772636, maxDeltaV: 17120, maxTime: 2686 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 16721.8, ascentDeltaV: 9577.1, time: 201767197, maxDeltaV: 17300, maxTime: 2686 * DAY },
    { site: 'kourou', offered: true, deltaV: 16430.2, ascentDeltaV: 9269.2, time: 201707864, maxDeltaV: 17010, maxTime: 2685 * DAY },
    { site: 'baikonur', offered: true, deltaV: 16644.6, ascentDeltaV: 9469.3, time: 201728770, maxDeltaV: 17220, maxTime: 2686 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 16521.1, ascentDeltaV: 9345.7, time: 201704941, maxDeltaV: 17100, maxTime: 2685 * DAY },
    { site: 'mahia', offered: true, deltaV: 16565.5, ascentDeltaV: 9393.0, time: 201713127, maxDeltaV: 17140, maxTime: 2685 * DAY },
    { site: 'equator', offered: true, deltaV: 16408.6, ascentDeltaV: 9265.8, time: 201682520, maxDeltaV: 16990, maxTime: 2685 * DAY },
  ],
};

/**
 * The par site of a campaign mission: the offered site whose reference
 * solution has the lowest total delta-v (ties: the earlier in the table).
 * Missions open there and score against its reference, so PAR_SCORE means
 * matching the best known launch from any site.
 */
export function parSite(id: string): string {
  let best: { site: string; deltaV: number } | undefined;
  for (const o of CAMPAIGN_SITES[id]) if (o.offered && (!best || o.deltaV < best.deltaV)) best = o;
  if (!best) throw new Error(`${id}: no offered site`);
  return best.site;
}

/**
 * Par scoring of a campaign mission: the reference solution from the given
 * site (its par site, parSite, unless the mission is about one site), delta-v
 * and time, weights 1:1. One par for every site.
 */
export function sitePar(id: string, site: string): { deltaVRef: number; deltaVWeight: number; timeRef: number; timeWeight: number } {
  const o = CAMPAIGN_SITES[id].find((s) => s.site === site);
  if (!o || !o.offered) throw new Error(`${id}: default site ${site} is not offered`);
  return { deltaVRef: o.deltaV, deltaVWeight: 1, timeRef: o.time, timeWeight: 1 };
}

/** Offered site ids of a campaign mission, in table order. */
export function offeredSites(id: string): string[] {
  return CAMPAIGN_SITES[id].filter((s) => s.offered).map((s) => s.site);
}

/** Loosest offered limits of a campaign mission (its max-delta-v / max-time objectives). */
export function loosestLimits(id: string): { maxDeltaV: number; maxTime: number } {
  let maxDeltaV = 0;
  let maxTime = 0;
  for (const s of CAMPAIGN_SITES[id]) {
    if (!s.offered) continue;
    maxDeltaV = Math.max(maxDeltaV, s.maxDeltaV);
    maxTime = Math.max(maxTime, s.maxTime);
  }
  return { maxDeltaV, maxTime };
}
