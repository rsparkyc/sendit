/**
 * Launch sites per campaign mission: for every site of the launch-site table
 * (data/launch-sites.json), whether the mission is offered from it, with that
 * site's reference solution (delta-v, m/s; mission time, s) and limits, or
 * why not. Plain data, shown by the game and the leaderboard.
 *
 * WHERE THE NUMBERS COME FROM. Each offered (mission, site) pair was solved
 * with the planning aids (test/mission-campaign-sites-solve.test.ts) and the
 * plan is kept as a literal in test/mission-campaign-sites.test.ts, which
 * flies it on every run (interplanetary ones with SLOW=1). The default site's
 * values are the mission's par (test/mission-campaign.test.ts). References
 * are evidence that the mission is achievable from the site, not optima.
 *
 * LIMITS per site, from that site's reference, with the margins campaign.ts
 * uses for the default site: delta-v x 1.08 rounded up to 10 m/s (the three
 * sample missions: the same ratio as their original limit to their par);
 * time x 1.25 rounded up to the hour near Earth, x 1.15 rounded up to the day
 * for interplanetary missions (the samples keep their flat time limits);
 * never above the mission's maxDuration. The default site keeps exactly the
 * limits it had before sites were offered. Scoring has one par per mission
 * for every site (campaign.ts), so a better site scores better.
 *
 * NOT OFFERED. plane-change only: its lesson is the Cape corridor's 60°
 * ceiling, and every other site reaches 64-66° directly (no plane change to
 * make). Every other mission was solved from all seven sites.
 */
import type { SiteOption } from './objectives';

const DAY = 86400;
const HOUR = 3600;

export const CAMPAIGN_SITES: Readonly<Record<string, readonly SiteOption[]>> = {
  'plane-change': [
    { site: 'cape-canaveral', offered: true, deltaV: 723.2, time: 25540, maxDeltaV: 790, maxTime: 9 * HOUR },
    { site: 'vandenberg', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'kourou', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'baikonur', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'tanegashima', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'mahia', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'equator', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
  ],
  'geo-from-leo': [
    { site: 'cape-canaveral', offered: true, deltaV: 4300.8, time: 300187, maxDeltaV: 4930, maxTime: 6 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 5351.9, time: 310932, maxDeltaV: 6130, maxTime: 6 * DAY },
    { site: 'kourou', offered: true, deltaV: 3932, time: 347164, maxDeltaV: 4500, maxTime: 6 * DAY },
    { site: 'baikonur', offered: true, deltaV: 4933.7, time: 309538, maxDeltaV: 5650, maxTime: 6 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 4345.8, time: 304182, maxDeltaV: 4980, maxTime: 6 * DAY },
    { site: 'mahia', offered: true, deltaV: 4577.3, time: 297379, maxDeltaV: 5240, maxTime: 6 * DAY },
    { site: 'equator', offered: true, deltaV: 3917.1, time: 330155, maxDeltaV: 4490, maxTime: 6 * DAY },
  ],
  'earth-escape': [
    { site: 'cape-canaveral', offered: true, deltaV: 3665.5, time: 110024, maxDeltaV: 3960, maxTime: 138240 },
    { site: 'vandenberg', offered: true, deltaV: 3667.7, time: 109992, maxDeltaV: 3970, maxTime: 39 * HOUR },
    { site: 'kourou', offered: true, deltaV: 3663.9, time: 110037, maxDeltaV: 3960, maxTime: 39 * HOUR },
    { site: 'baikonur', offered: true, deltaV: 3667.4, time: 109997, maxDeltaV: 3970, maxTime: 39 * HOUR },
    { site: 'tanegashima', offered: true, deltaV: 3665.1, time: 110022, maxDeltaV: 3960, maxTime: 39 * HOUR },
    { site: 'mahia', offered: true, deltaV: 3666, time: 110014, maxDeltaV: 3960, maxTime: 39 * HOUR },
    { site: 'equator', offered: true, deltaV: 3663.5, time: 110037, maxDeltaV: 3960, maxTime: 39 * HOUR },
  ],
  'lunar-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 3312.3, time: 156716, maxDeltaV: 3670, maxTime: 7 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 3153.2, time: 316246, maxDeltaV: 3490, maxTime: 7 * DAY },
    { site: 'kourou', offered: true, deltaV: 3167.2, time: 252044, maxDeltaV: 3500, maxTime: 7 * DAY },
    { site: 'baikonur', offered: true, deltaV: 3146.3, time: 320788, maxDeltaV: 3480, maxTime: 7 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3148.4, time: 319404, maxDeltaV: 3480, maxTime: 7 * DAY },
    { site: 'mahia', offered: true, deltaV: 3155.1, time: 284814, maxDeltaV: 3490, maxTime: 7 * DAY },
    { site: 'equator', offered: true, deltaV: 3140.9, time: 342765, maxDeltaV: 3480, maxTime: 7 * DAY },
  ],
  'lunar-free-return': [
    { site: 'cape-canaveral', offered: true, deltaV: 3170, time: 602492, maxDeltaV: 3310, maxTime: 12 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 3154.4, time: 647370, maxDeltaV: 3290, maxTime: 12 * DAY },
    { site: 'kourou', offered: true, deltaV: 3167.2, time: 704161, maxDeltaV: 3300, maxTime: 12 * DAY },
    { site: 'baikonur', offered: true, deltaV: 3159.9, time: 827219, maxDeltaV: 3300, maxTime: 12 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3152.9, time: 825303, maxDeltaV: 3290, maxTime: 12 * DAY },
    { site: 'mahia', offered: true, deltaV: 3155.1, time: 650738, maxDeltaV: 3290, maxTime: 12 * DAY },
    { site: 'equator', offered: true, deltaV: 3168.1, time: 726483, maxDeltaV: 3310, maxTime: 12 * DAY },
  ],
  'lunar-orbit': [
    { site: 'cape-canaveral', offered: true, deltaV: 4239.7, time: 244823, maxDeltaV: 4580, maxTime: 86 * HOUR },
    { site: 'vandenberg', offered: true, deltaV: 3833.7, time: 376486, maxDeltaV: 4150, maxTime: 131 * HOUR },
    { site: 'kourou', offered: true, deltaV: 4201.4, time: 250761, maxDeltaV: 4540, maxTime: 90 * HOUR },
    { site: 'baikonur', offered: true, deltaV: 3817.8, time: 375231, maxDeltaV: 4130, maxTime: 131 * HOUR },
    { site: 'tanegashima', offered: true, deltaV: 3780.1, time: 377965, maxDeltaV: 4090, maxTime: 132 * HOUR },
    { site: 'mahia', offered: true, deltaV: 3786.4, time: 349135, maxDeltaV: 4090, maxTime: 122 * HOUR },
    { site: 'equator', offered: true, deltaV: 4098.8, time: 263319, maxDeltaV: 4430, maxTime: 92 * HOUR },
  ],
  'venus-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 3660, time: 14901542, maxDeltaV: 3960, maxTime: 199 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 3679.2, time: 14873093, maxDeltaV: 3980, maxTime: 198 * DAY },
    { site: 'kourou', offered: true, deltaV: 3665.2, time: 14938905, maxDeltaV: 3960, maxTime: 199 * DAY },
    { site: 'baikonur', offered: true, deltaV: 3796.4, time: 14938758, maxDeltaV: 4110, maxTime: 199 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3651.8, time: 14873943, maxDeltaV: 3950, maxTime: 198 * DAY },
    { site: 'mahia', offered: true, deltaV: 3680.8, time: 14914953, maxDeltaV: 3980, maxTime: 199 * DAY },
    { site: 'equator', offered: true, deltaV: 3661.2, time: 14910097, maxDeltaV: 3960, maxTime: 199 * DAY },
  ],
  'mars-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 3713.2, time: 27334248, maxDeltaV: 4020, maxTime: 364 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 4000.1, time: 27805756, maxDeltaV: 4330, maxTime: 371 * DAY },
    { site: 'kourou', offered: true, deltaV: 3717.2, time: 27362106, maxDeltaV: 4020, maxTime: 365 * DAY },
    { site: 'baikonur', offered: true, deltaV: 3864.2, time: 27361827, maxDeltaV: 4180, maxTime: 365 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3750.2, time: 27374992, maxDeltaV: 4060, maxTime: 365 * DAY },
    { site: 'mahia', offered: true, deltaV: 3762, time: 27340201, maxDeltaV: 4070, maxTime: 364 * DAY },
    { site: 'equator', offered: true, deltaV: 3712.6, time: 27335328, maxDeltaV: 4010, maxTime: 364 * DAY },
  ],
  'mars-orbit': [
    { site: 'cape-canaveral', offered: true, deltaV: 4877.5, time: 26042045, maxDeltaV: 5270, maxTime: 347 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 5028.6, time: 26097250, maxDeltaV: 5440, maxTime: 348 * DAY },
    { site: 'kourou', offered: true, deltaV: 4880.3, time: 26072298, maxDeltaV: 5280, maxTime: 348 * DAY },
    { site: 'baikonur', offered: true, deltaV: 5010.5, time: 26076455, maxDeltaV: 5420, maxTime: 348 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 4915.3, time: 26094379, maxDeltaV: 5310, maxTime: 348 * DAY },
    { site: 'mahia', offered: true, deltaV: 4928.1, time: 26057479, maxDeltaV: 5330, maxTime: 347 * DAY },
    { site: 'equator', offered: true, deltaV: 4876.7, time: 26043696, maxDeltaV: 5270, maxTime: 347 * DAY },
  ],
  'venus-to-mercury': [
    { site: 'cape-canaveral', offered: true, deltaV: 5153.6, time: 28965251, maxDeltaV: 5570, maxTime: 386 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 5137.8, time: 28942469, maxDeltaV: 5550, maxTime: 386 * DAY },
    { site: 'kourou', offered: true, deltaV: 5116, time: 28973338, maxDeltaV: 5530, maxTime: 386 * DAY },
    { site: 'baikonur', offered: true, deltaV: 5135.1, time: 28929226, maxDeltaV: 5550, maxTime: 386 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 5123.1, time: 28925366, maxDeltaV: 5540, maxTime: 386 * DAY },
    { site: 'mahia', offered: true, deltaV: 5196.1, time: 28984435, maxDeltaV: 5620, maxTime: 386 * DAY },
    { site: 'equator', offered: true, deltaV: 5116.5, time: 28909540, maxDeltaV: 5530, maxTime: 385 * DAY },
  ],
  'solar-escape': [
    { site: 'cape-canaveral', offered: true, deltaV: 6578.2, time: 71779226, maxDeltaV: 7110, maxTime: 956 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 6586.5, time: 71774032, maxDeltaV: 7120, maxTime: 956 * DAY },
    { site: 'kourou', offered: true, deltaV: 6570.5, time: 71726933, maxDeltaV: 7100, maxTime: 955 * DAY },
    { site: 'baikonur', offered: true, deltaV: 6585.8, time: 71754379, maxDeltaV: 7120, maxTime: 956 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 6572.7, time: 71745635, maxDeltaV: 7100, maxTime: 955 * DAY },
    { site: 'mahia', offered: true, deltaV: 6570.6, time: 71721931, maxDeltaV: 7100, maxTime: 955 * DAY },
    { site: 'equator', offered: true, deltaV: 6572.5, time: 71741530, maxDeltaV: 7100, maxTime: 955 * DAY },
  ],
  'jupiter-saturn': [
    { site: 'cape-canaveral', offered: true, deltaV: 6661, time: 201842511, maxDeltaV: 7200, maxTime: 2687 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 6665.3, time: 201788015, maxDeltaV: 7200, maxTime: 2686 * DAY },
    { site: 'kourou', offered: true, deltaV: 6637.7, time: 201865199, maxDeltaV: 7170, maxTime: 2687 * DAY },
    { site: 'baikonur', offered: true, deltaV: 6749.4, time: 201856677, maxDeltaV: 7290, maxTime: 2687 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 6718, time: 201895036, maxDeltaV: 7260, maxTime: 2688 * DAY },
    { site: 'mahia', offered: true, deltaV: 6694.5, time: 201862859, maxDeltaV: 7240, maxTime: 2687 * DAY },
    { site: 'equator', offered: true, deltaV: 6635.6, time: 201819446, maxDeltaV: 7170, maxTime: 2687 * DAY },
  ],
};

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
