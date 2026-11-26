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
 * time x 1.25 rounded up to 10 minutes near Earth (to the hour before physics
 * model 2; plane change's re-solved 6.1-hour reference would get 30% from
 * hour rounding, outside the 15-30% band), x 1.15 rounded up to the day
 * for interplanetary missions (the samples keep their flat time limits);
 * never above the mission's maxDuration. Under physics model 2 every site's
 * limits, the default site's included, were re-derived by these rules from
 * the re-solved references (the three samples' default site, Kourou, keeps
 * its first-version limits). Scoring has one par per mission for every site
 * (campaign.ts), so a better site scores better.
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
    { site: 'cape-canaveral', offered: true, deltaV: 719.3, time: 22106, maxDeltaV: 780, maxTime: 28200 },
    { site: 'vandenberg', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'kourou', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'baikonur', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'tanegashima', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'mahia', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
    { site: 'equator', offered: false, reason: 'its corridor reaches 64-66° directly, so there is no plane change to make; the mission is about the Cape corridor’s 60° limit' },
  ],
  'geo-from-leo': [
    { site: 'cape-canaveral', offered: true, deltaV: 4299.2, time: 331627, maxDeltaV: 4930, maxTime: 6 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 5353.5, time: 334507, maxDeltaV: 6130, maxTime: 6 * DAY },
    { site: 'kourou', offered: true, deltaV: 3931.5, time: 347070, maxDeltaV: 4500, maxTime: 6 * DAY },
    { site: 'baikonur', offered: true, deltaV: 4937.5, time: 291173, maxDeltaV: 5660, maxTime: 6 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 4343.8, time: 304266, maxDeltaV: 4980, maxTime: 6 * DAY },
    { site: 'mahia', offered: true, deltaV: 4586.7, time: 355900, maxDeltaV: 5250, maxTime: 6 * DAY },
    { site: 'equator', offered: true, deltaV: 3917.1, time: 330021, maxDeltaV: 4490, maxTime: 6 * DAY },
  ],
  'earth-escape': [
    { site: 'cape-canaveral', offered: true, deltaV: 3665.5, time: 110024, maxDeltaV: 3960, maxTime: 138000 },
    { site: 'vandenberg', offered: true, deltaV: 3667.7, time: 109992, maxDeltaV: 3970, maxTime: 138000 },
    { site: 'kourou', offered: true, deltaV: 3663.9, time: 110036, maxDeltaV: 3960, maxTime: 138000 },
    { site: 'baikonur', offered: true, deltaV: 3667.3, time: 109998, maxDeltaV: 3970, maxTime: 138000 },
    { site: 'tanegashima', offered: true, deltaV: 3665.2, time: 110021, maxDeltaV: 3960, maxTime: 138000 },
    { site: 'mahia', offered: true, deltaV: 3666, time: 110013, maxDeltaV: 3960, maxTime: 138000 },
    { site: 'equator', offered: true, deltaV: 3663.6, time: 110036, maxDeltaV: 3960, maxTime: 138000 },
  ],
  'lunar-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 3309.3, time: 157593, maxDeltaV: 3660, maxTime: 7 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 3153.2, time: 316237, maxDeltaV: 3490, maxTime: 7 * DAY },
    { site: 'kourou', offered: true, deltaV: 3167.2, time: 252040, maxDeltaV: 3500, maxTime: 7 * DAY },
    { site: 'baikonur', offered: true, deltaV: 3146.3, time: 320729, maxDeltaV: 3480, maxTime: 7 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3148.4, time: 319400, maxDeltaV: 3480, maxTime: 7 * DAY },
    { site: 'mahia', offered: true, deltaV: 3154.7, time: 285427, maxDeltaV: 3490, maxTime: 7 * DAY },
    { site: 'equator', offered: true, deltaV: 3140.9, time: 342369, maxDeltaV: 3480, maxTime: 7 * DAY },
  ],
  'lunar-free-return': [
    { site: 'cape-canaveral', offered: true, deltaV: 3167.7, time: 654846, maxDeltaV: 3310, maxTime: 12 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 3154.9, time: 669045, maxDeltaV: 3290, maxTime: 12 * DAY },
    { site: 'kourou', offered: true, deltaV: 3167.2, time: 704047, maxDeltaV: 3300, maxTime: 12 * DAY },
    { site: 'baikonur', offered: true, deltaV: 3159.9, time: 804210, maxDeltaV: 3300, maxTime: 12 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3152.9, time: 825310, maxDeltaV: 3290, maxTime: 12 * DAY },
    { site: 'mahia', offered: true, deltaV: 3168.4, time: 886478, maxDeltaV: 3310, maxTime: 12 * DAY },
    { site: 'equator', offered: true, deltaV: 3168.2, time: 680438, maxDeltaV: 3310, maxTime: 12 * DAY },
  ],
  'lunar-orbit': [
    { site: 'cape-canaveral', offered: true, deltaV: 4217, time: 247452, maxDeltaV: 4560, maxTime: 86 * HOUR },
    { site: 'vandenberg', offered: true, deltaV: 3833.7, time: 376474, maxDeltaV: 4150, maxTime: 471000 },
    { site: 'kourou', offered: true, deltaV: 4201.2, time: 250814, maxDeltaV: 4540, maxTime: 313800 },
    { site: 'baikonur', offered: true, deltaV: 3812.9, time: 376557, maxDeltaV: 4120, maxTime: 471000 },
    { site: 'tanegashima', offered: true, deltaV: 3780.3, time: 377937, maxDeltaV: 4090, maxTime: 472800 },
    { site: 'mahia', offered: true, deltaV: 3783.7, time: 352454, maxDeltaV: 4090, maxTime: 441000 },
    { site: 'equator', offered: true, deltaV: 4123.6, time: 259908, maxDeltaV: 4460, maxTime: 325200 },
  ],
  'venus-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 3659.8, time: 14901542, maxDeltaV: 3960, maxTime: 199 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 3679.6, time: 14873300, maxDeltaV: 3980, maxTime: 198 * DAY },
    { site: 'kourou', offered: true, deltaV: 3664.8, time: 14938905, maxDeltaV: 3960, maxTime: 199 * DAY },
    { site: 'baikonur', offered: true, deltaV: 3796.1, time: 14938781, maxDeltaV: 4100, maxTime: 199 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3651.7, time: 14873943, maxDeltaV: 3950, maxTime: 198 * DAY },
    { site: 'mahia', offered: true, deltaV: 3689.5, time: 14922760, maxDeltaV: 3990, maxTime: 199 * DAY },
    { site: 'equator', offered: true, deltaV: 3660.9, time: 14910101, maxDeltaV: 3960, maxTime: 199 * DAY },
  ],
  'mars-flyby': [
    { site: 'cape-canaveral', offered: true, deltaV: 3713.2, time: 27334261, maxDeltaV: 4020, maxTime: 364 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 3995.4, time: 27795197, maxDeltaV: 4320, maxTime: 370 * DAY },
    { site: 'kourou', offered: true, deltaV: 3717.7, time: 27364346, maxDeltaV: 4020, maxTime: 365 * DAY },
    { site: 'baikonur', offered: true, deltaV: 4268.6, time: 28227179, maxDeltaV: 4620, maxTime: 376 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 3753.1, time: 27379858, maxDeltaV: 4060, maxTime: 365 * DAY },
    { site: 'mahia', offered: true, deltaV: 3763.7, time: 27343951, maxDeltaV: 4070, maxTime: 364 * DAY },
    { site: 'equator', offered: true, deltaV: 3712.7, time: 27336112, maxDeltaV: 4010, maxTime: 364 * DAY },
  ],
  'mars-orbit': [
    { site: 'cape-canaveral', offered: true, deltaV: 4878.2, time: 26066288, maxDeltaV: 5270, maxTime: 347 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 5022.8, time: 26094298, maxDeltaV: 5430, maxTime: 348 * DAY },
    { site: 'kourou', offered: true, deltaV: 4881, time: 26097457, maxDeltaV: 5280, maxTime: 348 * DAY },
    { site: 'baikonur', offered: true, deltaV: 5012.1, time: 26075523, maxDeltaV: 5420, maxTime: 348 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 4916.2, time: 26118580, maxDeltaV: 5310, maxTime: 348 * DAY },
    { site: 'mahia', offered: true, deltaV: 4928.9, time: 26079348, maxDeltaV: 5330, maxTime: 348 * DAY },
    { site: 'equator', offered: true, deltaV: 4877.4, time: 26067972, maxDeltaV: 5270, maxTime: 347 * DAY },
  ],
  'venus-to-mercury': [
    { site: 'cape-canaveral', offered: true, deltaV: 5144.4, time: 28963878, maxDeltaV: 5560, maxTime: 386 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 5133.5, time: 28944262, maxDeltaV: 5550, maxTime: 386 * DAY },
    { site: 'kourou', offered: true, deltaV: 5114.9, time: 28975503, maxDeltaV: 5530, maxTime: 386 * DAY },
    { site: 'baikonur', offered: true, deltaV: 5127.4, time: 28927641, maxDeltaV: 5540, maxTime: 386 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 5119.8, time: 28927067, maxDeltaV: 5530, maxTime: 386 * DAY },
    { site: 'mahia', offered: true, deltaV: 5186.5, time: 28986353, maxDeltaV: 5610, maxTime: 386 * DAY },
    { site: 'equator', offered: true, deltaV: 5118.6, time: 28956342, maxDeltaV: 5530, maxTime: 386 * DAY },
  ],
  'solar-escape': [
    { site: 'cape-canaveral', offered: true, deltaV: 6578.7, time: 71779226, maxDeltaV: 7110, maxTime: 956 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 6586, time: 71774032, maxDeltaV: 7120, maxTime: 956 * DAY },
    { site: 'kourou', offered: true, deltaV: 6570.6, time: 71726932, maxDeltaV: 7100, maxTime: 955 * DAY },
    { site: 'baikonur', offered: true, deltaV: 6585.6, time: 71754378, maxDeltaV: 7120, maxTime: 956 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 6573, time: 71745635, maxDeltaV: 7100, maxTime: 955 * DAY },
    { site: 'mahia', offered: true, deltaV: 6570.6, time: 71721931, maxDeltaV: 7100, maxTime: 955 * DAY },
    { site: 'equator', offered: true, deltaV: 6572.7, time: 71741529, maxDeltaV: 7100, maxTime: 955 * DAY },
  ],
  'jupiter-saturn': [
    { site: 'cape-canaveral', offered: true, deltaV: 6710.7, time: 201753561, maxDeltaV: 7250, maxTime: 2686 * DAY },
    { site: 'vandenberg', offered: true, deltaV: 6712.2, time: 201738895, maxDeltaV: 7250, maxTime: 2686 * DAY },
    { site: 'kourou', offered: true, deltaV: 6638.5, time: 201687133, maxDeltaV: 7170, maxTime: 2685 * DAY },
    { site: 'baikonur', offered: true, deltaV: 6691.9, time: 201720858, maxDeltaV: 7230, maxTime: 2685 * DAY },
    { site: 'tanegashima', offered: true, deltaV: 6673.6, time: 201717503, maxDeltaV: 7210, maxTime: 2685 * DAY },
    { site: 'mahia', offered: true, deltaV: 6659.9, time: 201723597, maxDeltaV: 7200, maxTime: 2685 * DAY },
    { site: 'equator', offered: true, deltaV: 6637.9, time: 201689897, maxDeltaV: 7170, maxTime: 2685 * DAY },
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
