/**
 * Every campaign mission from every launch site it offers: a solution per
 * (mission, site), flown as a player's shared plan would be (encode -> decode
 * -> replay with the mission's options -> evaluate with conformance), on the
 * real ephemeris. These plans are where each site's reference values and
 * limits in src/mission/campaign-sites.ts come from; they live only here.
 * The default site's solution is the mission's par (mission-campaign.test.ts).
 * How they were found: test/mission-campaign-sites-solve.test.ts (SLOW=1).
 *
 * Near-Earth missions run by default; interplanetary ones (months to years of
 * flight each) only with SLOW=1:
 *   SLOW=1 pnpm vitest run test/mission-campaign-sites.test.ts
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../src/mission/campaign';
import { CAMPAIGN_SITES } from '../src/mission/campaign-sites';
import { azimuthForInclination, LAUNCH_SITES, launchSite, launchToParams } from '../src/mission/launch';
import { allowedSites, checkPlanConformance, evaluate, missionForSite, missionReplayOptions, type CompleteMission } from '../src/mission/objectives';
import { decodePlan, encodePlan, makePlan, type MissionPlan, type PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { realWorld, SLOW } from './helpers/real-world';

const { world } = realWorld();

interface Solution { params: number[]; duration: number; rtol: number; burns: PlanBurn[] }

/** Per-site solutions (default sites excluded: see mission-campaign.test.ts). */
const SITE_SOLUTIONS: Record<string, Record<string, Solution>> = {
  'geo-from-leo': {
    'cape-canaveral': {"params": [852854469.184, 88.24949008066518, 250000], "duration": 349041.0474524498, "rtol": 1e-10, "burns": [{"start": 1508.8745226264855, "duration": 432.4445222614486, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20574.820820886605, "duration": 199.5398513318286, "engine": 0, "direction": [1456.6527542695733, -1118.5736687872097, -12.321414826736849], "frame": {"kind": "orbital", "body": "earth"}}]},
    'vandenberg': {"params": [852854469.184, 147.0470830984296, 250000], "duration": 350925.3231765032, "rtol": 1e-10, "burns": [{"start": 3395.279908508088, "duration": 432.7016783356157, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22178.393050597977, "duration": 280.45597654077903, "engine": 0, "direction": [759.0806923178313, 1293.2406202066481, -34.47755527400169], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852854469.184, 64.87662563341813, 250000], "duration": 349331.4852119684, "rtol": 1e-10, "burns": [{"start": 1800.5171575845543, "duration": 432.6132768986099, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20957.818694095793, "duration": 250.54150216246262, "engine": 0, "direction": [1510.6159668151492, -2059.5736132451375, 15.48828454331035], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852854469.184, 91.05933318744303, 250000], "duration": 348972.22473692894, "rtol": 1e-10, "burns": [{"start": 1440.117479235034, "duration": 432.45688647011775, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20440.534747082904, "duration": 203.40955591713163, "engine": 0, "direction": [1501.0120309539313, -1226.2731449619234, -27.409738021955874], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852854469.184, 88.41627088596617, 250000], "duration": 348962.45153295994, "rtol": 1e-10, "burns": [{"start": 1431.2373630107595, "duration": 432.5240258572194, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20366.34245487567, "duration": 222.7172808628354, "engine": 0, "direction": [1436.978071844287, 1506.161036324496, -38.42503849064764], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852854469.184, 90, 250000], "duration": 349356.17677533627, "rtol": 1e-10, "burns": [{"start": 1823.8271957338293, "duration": 432.34560853234143, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20953.755561524486, "duration": 164.84242762355817, "engine": 0, "direction": [1467.6249403812965, 4.181942405227618, -1.6346162288484953], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'earth-escape': {
    'vandenberg': {"params": [852854469.184, 147.0470830984296, 300000], "duration": 109991.70690643787, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8550.603317856789, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22835.233158703893, "duration": 862.9474954679608, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [852854469.184, 89.3064986106911, 300000], "duration": 110036.32484221458, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8559.052196502686, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22880.441658884287, "duration": 861.7663666605949, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852854469.184, 64.87662563341813, 300000], "duration": 109996.71061003208, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8549.637379288673, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22840.288977339864, "duration": 862.8432653844357, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852854469.184, 91.05933318744303, 300000], "duration": 110021.79066121578, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8555.555364251137, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22865.72153369896, "duration": 862.138255033642, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852854469.184, 88.41627088596617, 300000], "duration": 110013.1962262392, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8553.505031228065, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22856.982575805858, "duration": 862.4273008666933, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852854469.184, 90, 300000], "duration": 110036.77186346054, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8559.165858626366, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22880.950240645558, "duration": 861.6432456299663, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'lunar-flyby': {
    'cape-canaveral': {"params": [852906603.6780126, 81.66648753081454, 200000], "duration": 243116, "rtol": 1e-10, "burns": [{"start": 1901.00816064926, "duration": 349.4450038831709, "engine": 0, "direction": [1, -0.005616529922335537, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'vandenberg': {"params": [852898575.9758744, 147.2407516246168, 200000], "duration": 402646, "rtol": 1e-10, "burns": [{"start": 3332.672040497009, "duration": 337.9734392188535, "engine": 0, "direction": [1, 0.00865167155823842, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852917351.9531224, 64.35793963249952, 200000], "duration": 407188, "rtol": 1e-10, "burns": [{"start": 4347.318891032979, "duration": 337.4671642991676, "engine": 0, "direction": [1, 0.021603951065482463, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852915418.8771739, 99.29448635130461, 200000], "duration": 405804, "rtol": 1e-10, "burns": [{"start": 3720.5350258671147, "duration": 337.62058442571856, "engine": 0, "direction": [1, 0.008602345321113522, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852897460.7371192, 78.37053113099702, 200000], "duration": 371214, "rtol": 1e-10, "burns": [{"start": 4132.664574185434, "duration": 338.1111649940312, "engine": 0, "direction": [1, 0.011907217156169523, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852869562.4218683, 62.309923435111294, 200000], "duration": 429165, "rtol": 1e-10, "burns": [{"start": 3115.374416691591, "duration": 337.0695044853344, "engine": 0, "direction": [1, 0.0009118206755813406, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'lunar-free-return': {
    'cape-canaveral': {"params": [852906603.6780126, 81.66648753081454, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 1971.1093422767467, "duration": 339.2054258229077, "engine": 0, "direction": [1, 0.01909512231612745, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'vandenberg': {"params": [852898575.9758744, 147.2407516246168, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 3332.0933367933053, "duration": 338.0606305768782, "engine": 0, "direction": [1, -0.0007403037504035551, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852917351.9531224, 64.35793963249952, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 4387.318891032979, "duration": 338.4671642991676, "engine": 0, "direction": [1, 0.03360395106548247, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852915418.8771739, 99.29448635130461, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 3743.8683592004486, "duration": 337.9539177590518, "engine": 0, "direction": [1, -6.43213455531449e-05, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852897460.7371192, 78.37053113099702, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 4192.664574185434, "duration": 338.1111649940312, "engine": 0, "direction": [1, 0.0019072171561695227, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852869562.4218683, 62.309923435111294, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 3035.374416691591, "duration": 339.0695044853344, "engine": 0, "direction": [1, -0.00908817932441866, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'lunar-orbit': {
    'cape-canaveral': {"params": [852906603.6780126, 81.66648753081454, 200000], "duration": 314582.23897588253, "rtol": 1e-10, "burns": [{"start": 1566.3111939529342, "duration": 1012.01037326505, "engine": 0, "direction": [1, 0.017481678889060322, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 184897.9333437495, "duration": 168.6112642660737, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'vandenberg': {"params": [852898575.9758744, 147.2407516246168, 200000], "duration": 446209.6643152237, "rtol": 1e-10, "burns": [{"start": 2987.739144983736, "duration": 992.2429839243744, "engine": 0, "direction": [1, 0.01215589280816958, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 316550.7306230217, "duration": 117.86738440394402, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'baikonur': {"params": [852917351.9531224, 64.35793963249952, 200000], "duration": 444953.4171036482, "rtol": 1e-10, "burns": [{"start": 4030.298131851209, "duration": 992.190912372563, "engine": 0, "direction": [1, 0.024792427220757002, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 315295.8962715827, "duration": 115.04166413098574, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'tanegashima': {"params": [852915418.8771739, 99.29448635130461, 200000], "duration": 447705.6719735861, "rtol": 1e-10, "burns": [{"start": 3377.5767011800767, "duration": 991.1494490862884, "engine": 0, "direction": [1, 0.01779995844671768, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 318051.08576995693, "duration": 109.17240725830197, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'mahia': {"params": [852897460.7371192, 78.37053113099702, 200000], "duration": 418868.67472577095, "rtol": 1e-10, "burns": [{"start": 3818.0485478387222, "duration": 992.9511001682814, "engine": 0, "direction": [1, 0.01724980834439365, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 289214.414742209, "duration": 108.51996712386608, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'equator': {"params": [852869562.4218683, 62.309923435111294, 200000], "duration": 333075.4773284197, "rtol": 1e-10, "burns": [{"start": 2614.659410241834, "duration": 1005.7875285090338, "engine": 0, "direction": [1, 0.01156782678240453, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 203399.92730904184, "duration": 151.1000387556851, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
  },
  'venus-flyby': {
    'vandenberg': {"params": [890868499.4735782, 147.24075386770866, 200000], "duration": 14959492.63859272, "rtol": 1e-11, "burns": [{"start": 12402.562171936035, "duration": 415.9737532276961, "engine": 0, "direction": [0.9942681949477755, -0.10034355566104025, 0.03690429992009075], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [890802679.197984, 52.81016095993689, 200000], "duration": 15025304.853197098, "rtol": 1e-11, "burns": [{"start": 73262.7501449585, "duration": 414.96421939163724, "engine": 0, "direction": [0.9963502510917454, -0.0853296837978508, 0.0022410293114120575], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [890795791.921428, 63.09593824945798, 200000], "duration": 15025157.582309484, "rtol": 1e-11, "burns": [{"start": 82606.58532464504, "duration": 424.349442379882, "engine": 0, "direction": [0.9624087732160619, -0.27141777030601993, -0.01008698165278437], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [890867662.7531457, 113.32829675413419, 200000], "duration": 14960342.807962418, "rtol": 1e-11, "burns": [{"start": 8202.303275465965, "duration": 413.9842104486351, "engine": 0, "direction": [0.9999265773724699, -0.011689386863503112, 0.003193446247148643], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [890818435.0939219, 78.37050526971461, 200000], "duration": 15001352.464184523, "rtol": 1e-11, "burns": [{"start": 58405.08771324158, "duration": 416.091842705498, "engine": 0, "direction": [0.9920181385520624, -0.1255807404888907, -0.011379384955394268], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [890831499.7649641, 127.5000029398492, 200000], "duration": 14996496.757832766, "rtol": 1e-11, "burns": [{"start": 49503.223318099976, "duration": 414.66967808013766, "engine": 0, "direction": [0.9974368841639427, -0.07151846783254497, 0.002184231720926621], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'mars-flyby': {
    'vandenberg': {"params": [912345869.8458269, 147.2407552587539, 200000], "duration": 27892155.040239453, "rtol": 1e-11, "burns": [{"start": 81072.703399539, "duration": 876.7665340741534, "engine": 0, "direction": [0.932549759977517, -0.35140908329042003, 0.08284081932756579], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [912365209.3197396, 60.92191414623711, 200000], "duration": 27448505.419678092, "rtol": 1e-11, "burns": [{"start": 62357.44921731949, "duration": 837.435356591425, "engine": 0, "direction": [0.9948870106520166, -0.09697888996688837, -0.02819451962145443], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [912360396.2686462, 63.095959053533846, 200000], "duration": 27448226.869380713, "rtol": 1e-11, "burns": [{"start": 66226.98468017578, "duration": 858.194490259757, "engine": 0, "direction": [0.9567129971726895, -0.28111876467172237, -0.07531587608395697], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [912347894.5670536, 99.29453142782383, 200000], "duration": 27461391.615067363, "rtol": 1e-11, "burns": [{"start": 76709.65473127365, "duration": 842.1554667138928, "engine": 0, "direction": [0.9859608145774035, -0.16201431500721175, -0.04040586406212695], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [912385462.835635, 78.37051335062438, 200000], "duration": 27426600.18110478, "rtol": 1e-11, "burns": [{"start": 41960.08175075054, "duration": 843.8263160630914, "engine": 0, "direction": [0.9838233501509216, -0.17709881131990562, -0.026974557028683514], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [912393444.2091985, 119.50000567586572, 200000], "duration": 27421727.80759549, "rtol": 1e-11, "burns": [{"start": 33324.394137978554, "duration": 836.7738802721589, "engine": 0, "direction": [0.9960614257652102, -0.08374910644350904, -0.029115687738580052], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'mars-orbit': {
    'vandenberg': {"params": [911828317.7618294, 147.24075596250984, 200000], "duration": 26260166.32534623, "rtol": 1e-11, "burns": [{"start": 81191.83636569977, "duration": 511.1122236613578, "engine": 0, "direction": [0.9579561610231765, -0.28384933930785833, -0.04182757621749763], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 24594718.022152185, "duration": 0.14738542051961154, "engine": 0, "direction": [0.9975079405006839, 0.003069999761954248, 0.07048747221702305], "frame": {"kind": "inertial"}}, {"start": 26000921.863388482, "duration": 88.92391549452147, "engine": 0, "direction": [-1208.001821119427, -1.2139423688495299e-06, 0.0009035004489277298], "frame": {"kind": "orbital", "body": "mars"}}]},
    'kourou': {"params": [911847031.1226783, 60.92191392454367, 200000], "duration": 26235299.462896824, "rtol": 1e-11, "burns": [{"start": 62584.49605858326, "duration": 498.63114191230255, "engine": 0, "direction": [0.9957144923051503, -0.0924146205876031, 0.0034910908247188033], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 24102952.78573656, "duration": 0.0921266109167978, "engine": 0, "direction": [0.09350039905688312, -0.8554641452606001, 0.5093513242838921], "frame": {"kind": "inertial"}}, {"start": 25976053.556398593, "duration": 91.81299646462253, "engine": 0, "direction": [-1206.2944500453757, -1.466055323362525e-06, 0.001083597577320461], "frame": {"kind": "orbital", "body": "mars"}}]},
    'baikonur': {"params": [911842815.2402608, 63.09595802431028, 200000], "duration": 26239457.678768516, "rtol": 1e-11, "burns": [{"start": 66447.44116139412, "duration": 509.79217031855046, "engine": 0, "direction": [0.962208489262409, -0.27167243542287484, -0.01867916011913999], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23388294.52048254, "duration": 0.05949896056358206, "engine": 0, "direction": [0.3263234864242236, -0.8011587097291383, 0.5016549651235217], "frame": {"kind": "inertial"}}, {"start": 25980213.091678392, "duration": 89.17418024881866, "engine": 0, "direction": [-1206.649385208649, -1.2539917406684253e-06, 0.0009272579824255445], "frame": {"kind": "orbital", "body": "mars"}}]},
    'tanegashima': {"params": [911830084.3865948, 99.2945326126358, 200000], "duration": 26257378.3727839, "rtol": 1e-11, "burns": [{"start": 76926.9478251934, "duration": 501.7040825553756, "engine": 0, "direction": [0.9864441377107542, -0.16402368591880917, 0.0049187024401094225], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23406410.280450225, "duration": 0.016749798315169956, "engine": 0, "direction": [-0.92088042788677, -0.32692512969288134, -0.21236571547773922], "frame": {"kind": "inertial"}}, {"start": 25998132.81346142, "duration": 91.11864495990258, "engine": 0, "direction": [-1206.6384492838588, -1.4095144820203132e-06, 0.0010433468884372132], "frame": {"kind": "orbital", "body": "mars"}}]},
    'mahia': {"params": [911867830.487961, 78.37051254029235, 200000], "duration": 26220483.828089952, "rtol": 1e-11, "burns": [{"start": 42156.1228659153, "duration": 502.50712583978157, "engine": 0, "direction": [0.9841737412283244, -0.17719608757859817, -0.0018956854911318442], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23370134.49830401, "duration": 0.37742701815772733, "engine": 0, "direction": [0.1862541574802296, -0.9824641425326176, 0.008578896139844538], "frame": {"kind": "inertial"}}, {"start": 25961238.43179136, "duration": 90.79259717975839, "engine": 0, "direction": [-1205.910626945641, -1.3802163607579132e-06, 0.0010193523148984696], "frame": {"kind": "orbital", "body": "mars"}}]},
    'equator': {"params": [911875266.0119803, 119.50000577720364, 200000], "duration": 26206696.267510414, "rtol": 1e-11, "burns": [{"start": 33551.305884599686, "duration": 498.3549811458745, "engine": 0, "direction": [0.9965592564927631, -0.08283529450786158, 0.002821751652296468], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23355708.853631735, "duration": 0.0395328308712872, "engine": 0, "direction": [-0.06991147176060376, -0.8791549257683096, 0.4713798920335746], "frame": {"kind": "inertial"}}, {"start": 25947450.317979623, "duration": 91.89906158404168, "engine": 0, "direction": [-1206.4067050659496, -1.472162693971768e-06, 0.0010884439452780725], "frame": {"kind": "orbital", "body": "mars"}}]},
  },
  'venus-to-mercury': {
    'vandenberg': {"params": [1003970574.37288, 147.240744012398, 200000], "duration": 29028868.040465236, "rtol": 1e-11, "burns": [{"start": 38431.92010426521, "duration": 605.3887188739654, "engine": 0, "direction": [0.9971402877137038, -0.07557070482167927, 0.0005614187267281936], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 13995978.038380742, "duration": 1.6975974872837474, "engine": 0, "direction": [-0.3094373764796306, 0.014766510968596304, 0.9508051641588919], "frame": {"kind": "inertial"}}]},
    'kourou': {"params": [1003938265.0977271, 82.04125367407354, 200000], "duration": 29059737.924139977, "rtol": 1e-11, "burns": [{"start": 71010.4628508091, "duration": 604.2729146558237, "engine": 0, "direction": [0.9996284995968456, -0.027255475346101374, -4.309776423835553e-05], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 14028088.311723232, "duration": 1.449264573809173, "engine": 0, "direction": [-0.3390018090859505, 0.05982275644685069, 0.9388817876855177], "frame": {"kind": "inertial"}}]},
    'baikonur': {"params": [1003988118.4696493, 63.09597765938308, 200000], "duration": 29015625.76197672, "rtol": 1e-11, "burns": [{"start": 23576.038397312164, "duration": 604.9253094582302, "engine": 0, "direction": [0.9982958798142074, -0.05835190833495109, 0.0006254115820056096], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 13991233.895527005, "duration": 1.9930904788420156, "engine": 0, "direction": [-0.22691691788748972, -0.08170747438365493, 0.9704806031066703], "frame": {"kind": "inertial"}}]},
    'tanegashima': {"params": [1003986453.7351396, 99.29447472316866, 200000], "duration": 29011765.90202713, "rtol": 1e-11, "burns": [{"start": 22906.863652586937, "duration": 604.6359622472327, "engine": 0, "direction": [0.9987848547220063, -0.049282365920028104, 0.00024977442927714055], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 13979944.374947071, "duration": 1.5305189585732653, "engine": 0, "direction": [-0.3215662769524316, 0.0336247459204457, 0.946289863619355], "frame": {"kind": "inertial"}}]},
    'mahia': {"params": [1003931192.7580245, 78.37057611446683, 200000], "duration": 29070834.356687307, "rtol": 1e-11, "burns": [{"start": 78708.31577563286, "duration": 608.9066148489519, "engine": 0, "direction": [0.9857582815552568, -0.16809777449191587, -0.004873249028342256], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 14046175.962949038, "duration": 1.7952112731104137, "engine": 0, "direction": [-0.25358633789682916, -0.040208480724063564, 0.9664767184520989], "frame": {"kind": "inertial"}}]},
    'equator': {"params": [1004003906.9434352, 80.49999992900432, 200000], "duration": 28995939.427004814, "rtol": 1e-11, "burns": [{"start": 7832.669748306274, "duration": 604.1540402091075, "engine": 0, "direction": [0.9999771240928784, -0.006763848914589352, 4.048204918621987e-05], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 13962592.094790459, "duration": 1.5992285212346757, "engine": 0, "direction": [-0.2925289420712215, -0.01195008821354406, 0.9561819980748332], "frame": {"kind": "inertial"}}]},
  },
  'solar-escape': {
    'vandenberg': {"params": [983020021.717855, 147.240738294029, 200000], "duration": 71774031.63279796, "rtol": 1e-11, "burns": [{"start": 59328.41272556782, "duration": 769.7099102208887, "engine": 0, "direction": [0.9968225253529515, -0.07964625614246096, 0.0011518817013620405], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [983067121.2427425, 57.874185983159805, 200000], "duration": 71726932.3381052, "rtol": 1e-11, "burns": [{"start": 12875.544963121414, "duration": 768.8977589957402, "engine": 0, "direction": [0.9985717573139452, -0.05341965973980368, 0.0008862551681274769], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [983039675.0505142, 63.095988053748286, 200000], "duration": 71754378.6464374, "rtol": 1e-11, "burns": [{"start": 44401.47081267834, "duration": 769.6741002134038, "engine": 0, "direction": [0.9967936976555734, -0.07998110374771486, 0.0023124353887032023], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [983048418.855175, 102.53421820063828, 200000], "duration": 71745634.26625228, "rtol": 1e-11, "burns": [{"start": 32619.57831478119, "duration": 769.0128396363491, "engine": 0, "direction": [0.9982546342910463, -0.0590480013026109, 0.00100928619156035], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [983072122.5412126, 78.37053833468642, 200000], "duration": 71721930.7194922, "rtol": 1e-11, "burns": [{"start": 9166.88180744648, "duration": 768.9045678911122, "engine": 0, "direction": [0.9987943077541271, -0.04904132189892927, 0.00220896907167947], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [983052524.0546482, 57.500004166097675, 200000], "duration": 71741529.65873313, "rtol": 1e-11, "burns": [{"start": 28940.295395612717, "duration": 769.0008586467628, "engine": 0, "direction": [0.9982872979851158, -0.05849342543050005, 0.0009949185810639092], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'jupiter-saturn': {
    'vandenberg': {"params": [1088253892.208583, 147.24075190813798, 200000], "duration": 201960815.09548116, "rtol": 1e-11, "burns": [{"start": 12127.294026136398, "duration": 770.3821938876919, "engine": 0, "direction": [0.9970009008831716, -0.07729789449270996, -0.003773479182149338], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101653505.44179773, "duration": 3.2757231536981966, "engine": 0, "direction": [-0.00817102832116826, 0.7916624643008752, 0.6109040652289363], "frame": {"kind": "inertial"}}]},
    'kourou': {"params": [1088209131.7370305, 86.10013262921044, 200000], "duration": 202037999.2660346, "rtol": 1e-11, "burns": [{"start": 55996.291328430176, "duration": 768.9017113424503, "engine": 0, "direction": [0.9979917341401706, -0.022731533046770013, -0.059125087680599764], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101697359.13688135, "duration": 3.38193307066338, "engine": 0, "direction": [0.029132180751495197, 0.7717615533068805, 0.6352443788669156], "frame": {"kind": "inertial"}}]},
    'baikonur': {"params": [1088184551.821529, 63.09596649491657, 200000], "duration": 202029476.32910872, "rtol": 1e-11, "burns": [{"start": 82250.83530545235, "duration": 774.584349605317, "engine": 0, "direction": [0.9845316163159259, -0.17518272679689978, -0.002916968692593453], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101722208.78987074, "duration": 3.2137912535371043, "engine": 0, "direction": [-0.008202147200331356, 0.787037850354639, 0.6168501818841046], "frame": {"kind": "inertial"}}]},
    'tanegashima': {"params": [1088180834.709734, 99.29449017413968, 200000], "duration": 202067835.59084034, "rtol": 1e-11, "burns": [{"start": 86957.6079890728, "duration": 772.9524346848424, "engine": 0, "direction": [0.9881877793945929, -0.15201748304953286, -0.01938033803803612], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101725659.37094712, "duration": 3.312257098087695, "engine": 0, "direction": [0.028186019231510057, 0.7815761187587006, 0.623172784150565], "frame": {"kind": "inertial"}}]},
    'mahia': {"params": [1088212874.1944203, 78.37052799147484, 200000], "duration": 202035658.58984137, "rtol": 1e-11, "burns": [{"start": 52494.39496397972, "duration": 771.7816769185533, "engine": 0, "direction": [0.9924909812468022, -0.12224215671268789, -0.00430200720479947], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101693617.62066245, "duration": 3.3269239346955573, "engine": 0, "direction": [0.02759347077401658, 0.7867047275754357, 0.6167124710763542], "frame": {"kind": "inertial"}}]},
    'equator': {"params": [1088254474.7741218, 88.50000208421316, 200000], "duration": 201992245.59121513, "rtol": 1e-11, "burns": [{"start": 9992.287753105164, "duration": 768.7948107755424, "engine": 0, "direction": [0.9988942778104594, 0.0043893125860275375, -0.04680764566332064], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101652015.63835335, "duration": 3.3860596332173563, "engine": 0, "direction": [0.029285659940678815, 0.7696376562643098, 0.6378089276435531], "frame": {"kind": "inertial"}}]},
  },
};

function sitePlan(m: CompleteMission, site: string): MissionPlan {
  const s = SITE_SOLUTIONS[m.id][site];
  return makePlan({
    data: world.fingerprint, epoch: s.params[0], duration: s.duration, rtol: s.rtol,
    start: { kind: 'launch', site, params: launchToParams({ mode: 'parking-orbit', siteId: site, launchTime: s.params[0], azimuthDeg: s.params[1], altitudeM: s.params[2] }) },
    spacecraft: m.spacecraft, burns: s.burns,
  });
}

const limit = (m: { objectives: CompleteMission['objectives'] }, kind: 'max-delta-v' | 'max-time') => (m.objectives.find((o) => o.kind === kind) as { max: number }).max;
const NEAR_EARTH = new Set(['plane-change', 'geo-from-leo', 'earth-escape', 'lunar-flyby', 'lunar-free-return', 'lunar-orbit']);
const SAMPLE_IDS = new Set(['geo-from-leo', 'lunar-flyby', 'lunar-free-return']);
const defaultSite = (m: CompleteMission) => (m.start.kind === 'launch' ? m.start.site : '');

describe('launch-site table', () => {
  it('lists every launch site once per mission; rules, objectives and the default start agree with it', () => {
    for (const m of CAMPAIGN) {
      const opts = m.launchSites!;
      expect(opts.map((o) => o.site), m.id).toEqual(LAUNCH_SITES.map((s) => s.id));
      expect(m.launchSites).toBe(CAMPAIGN_SITES[m.id]);
      const offered = opts.filter((o) => o.offered);
      expect(m.rules.sites, m.id).toEqual(offered.map((o) => o.site));
      expect(allowedSites(m)).toEqual(offered.map((o) => o.site));
      expect(offered.map((o) => o.site)).toContain(defaultSite(m));
      // The objectives carry the loosest offered limits (evaluation without a plan never rejects a site's flight).
      expect(limit(m, 'max-delta-v'), m.id).toBe(Math.max(...offered.map((o) => (o.offered ? o.maxDeltaV : 0))));
      expect(limit(m, 'max-time'), m.id).toBe(Math.max(...offered.map((o) => (o.offered ? o.maxTime : 0))));
      for (const o of offered) {
        if (!o.offered) continue;
        const ms = missionForSite(m, o.site);
        expect(limit(ms, 'max-delta-v')).toBe(o.maxDeltaV);
        expect(limit(ms, 'max-time')).toBe(o.maxTime);
        expect(o.maxTime).toBeLessThanOrEqual(m.maxDuration);
        if (o.site === defaultSite(m)) {
          // The default site's reference is the mission's par.
          expect(o.deltaV).toBe(m.scoring.deltaVRef);
          expect(o.time).toBe(m.scoring.timeRef);
        } else expect(Object.keys(SITE_SOLUTIONS[m.id] ?? {})).toContain(o.site);
      }
      for (const o of opts) if (!o.offered) expect(o.reason.length, `${m.id} ${o.site}`).toBeGreaterThan(20);
    }
  });

  it('plane-change stays at Cape Canaveral: every other site reaches 64-66° directly, the Cape cannot', () => {
    const m = CAMPAIGN.find((x) => x.id === 'plane-change')!;
    for (const s of LAUNCH_SITES) {
      const reach = [64, 65, 66].some((inc) => {
        const a = azimuthForInclination(launchSite(s.id), inc);
        return !!a && (a.northerlyAllowed || a.southerlyAllowed);
      });
      expect(reach, s.id).toBe(s.id !== 'cape-canaveral');
      expect(m.launchSites!.find((o) => o.site === s.id)!.offered).toBe(s.id === 'cape-canaveral');
    }
  });

  it('conformance refuses a site the mission does not offer, with the reason', () => {
    const m = CAMPAIGN.find((x) => x.id === 'plane-change')!;
    const site = 'vandenberg';
    const t = m.epoch;
    const p = makePlan({ data: world.fingerprint, epoch: t, duration: 3600, rtol: 1e-10, start: { kind: 'launch', site, params: launchToParams({ mode: 'parking-orbit', siteId: site, launchTime: t, azimuthDeg: 160, altitudeM: 400e3 }) }, spacecraft: m.spacecraft, burns: [] });
    const issues = checkPlanConformance(m, p);
    expect(issues.map((i) => [i.code, i.path])).toEqual([['launch-site', 'start.site']]);
    expect(issues[0].message).toMatch(/vandenberg not offered for this mission: .*64-66°.*\(allowed: cape-canaveral\)/);
  });
});

describe('campaign solutions from every offered site', () => {
  for (const m of CAMPAIGN) {
    for (const o of m.launchSites!) {
      if (!o.offered || o.site === defaultSite(m)) continue;
      it.skipIf(!NEAR_EARTH.has(m.id) && !SLOW)(`${m.id} from ${o.site}: solvable within that site's limits`, { timeout: 300_000 }, () => {
        const plan = decodePlan(encodePlan(sitePlan(m, o.site)));
        expect(checkPlanConformance(m, plan)).toEqual([]);
        const r = replay(plan, world, missionReplayOptions(m));
        const ev = evaluate(m, r, world, plan.epoch, plan);
        const detail = `${m.id}@${o.site}: ${r.outcome} ${r.reason}; ` + ev.objectives.map((x) => `${x.ok ? 'ok' : 'NO'} ${x.objective.kind}: ${x.detail}`).join('; ');
        expect(ev.success, detail).toBe(true);
        expect(ev.site).toBe(o.site);
        // The table's reference values are this solution's.
        expect(Math.abs(ev.deltaV - o.deltaV)).toBeLessThan(0.1);
        expect(Math.abs(ev.missionTime - o.time)).toBeLessThan(1);
        // That site's limits leave the same margins as the default site's.
        const dvMargin = o.maxDeltaV / ev.deltaV - 1;
        const tMargin = o.maxTime / ev.missionTime - 1;
        if (SAMPLE_IDS.has(m.id)) expect(dvMargin).toBeGreaterThan(0.04);
        else {
          expect(dvMargin).toBeGreaterThanOrEqual(0.08);
          expect(dvMargin).toBeLessThan(0.1);
          expect(tMargin).toBeGreaterThanOrEqual(0.15);
          expect(tMargin).toBeLessThan(0.3);
        }
        // Scoring is shared by all sites: the same keys formula, against the mission's single par.
        expect(ev.keys).toBeDefined();
      });
    }
  }
});
