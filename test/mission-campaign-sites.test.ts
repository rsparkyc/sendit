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
    'cape-canaveral': {"params": [852854469.184, 88.24949008066518, 250000], "duration": 409523.61229872704, "rtol": 1e-10, "burns": [{"start": 1511.4082088172545, "duration": 432.44263583419524, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20623.205891215584, "duration": 199.40070768850853, "engine": 0, "direction": [1479.5222430162478, -1133.5175924564767, -1.7665509648373625], "frame": {"kind": "orbital", "body": "earth"}}]},
    'vandenberg': {"params": [852854469.184, 147.0470830984296, 250000], "duration": 411402.79541027546, "rtol": 1e-10, "burns": [{"start": 3392.795385331021, "duration": 432.70075541713595, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22425.070344867978, "duration": 280.5626839520938, "engine": 0, "direction": [947.007040286612, 1614.0644897388884, -6.163328163942266], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852854469.184, 64.87662563341813, 250000], "duration": 409810.29595661163, "rtol": 1e-10, "burns": [{"start": 1799.2617923916678, "duration": 432.60987812254825, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20752.996345914977, "duration": 250.8256714469523, "engine": 0, "direction": [1388.7034266394921, -1897.9099798180303, -30.07056830563954], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852854469.184, 91.05933318744303, 250000], "duration": 409448.40531790257, "rtol": 1e-10, "burns": [{"start": 1436.2984475195553, "duration": 432.4596397280402, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20546.71533738702, "duration": 203.23217819447515, "engine": 0, "direction": [1478.5782695880678, -1204.6943634007944, -1.5426144681417249], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852854469.184, 88.41627088596617, 250000], "duration": 409445.886988163, "rtol": 1e-10, "burns": [{"start": 1434.670627802734, "duration": 432.5232670900732, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20475.804997039068, "duration": 223.48197523955795, "engine": 0, "direction": [1476.3802050156373, 1560.4180116836, -14.95005242791435], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852854469.184, 90, 250000], "duration": 409836.1977748871, "rtol": 1e-10, "burns": [{"start": 1823.8258412778941, "duration": 432.3483174442117, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 20953.77729542789, "duration": 164.84095891838888, "engine": 0, "direction": [1467.623480702009, -0.02043547171310678, -1.6346071245619722], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'earth-escape': {
    'vandenberg': {"params": [852854469.184, 147.0470830984296, 300000], "duration": 109991.8122934103, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8550.697231650352, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22835.337464876473, "duration": 862.9496570676565, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [852854469.184, 89.3064986106911, 300000], "duration": 110036.31313323975, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8559.000291466713, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22880.43142256327, "duration": 861.7634213529527, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852854469.184, 64.87662563341813, 300000], "duration": 109997.57820487022, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8549.78204369545, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22841.162514016032, "duration": 862.8313817083836, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852854469.184, 91.05933318744303, 300000], "duration": 110021.351603508, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8555.502430081367, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22865.276648379862, "duration": 862.1499102562666, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852854469.184, 88.41627088596617, 300000], "duration": 110013.31090795994, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8553.55495274067, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22857.098239466548, "duration": 862.4253369867802, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852854469.184, 90, 300000], "duration": 110036.24429500103, "rtol": 1e-10, "burns": [{"start": 1000, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 8559.04580628872, "duration": 650, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 22880.416550556198, "duration": 861.6554888896644, "engine": 0, "direction": [1, 0, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'lunar-flyby': {
    'cape-canaveral': {"params": [852906603.6786397, 81.66648753114096, 200000], "duration": 243993, "rtol": 1e-10, "burns": [{"start": 1900.380010879735, "duration": 349.2336974801397, "engine": 0, "direction": [1, -0.005459271675506812, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'vandenberg': {"params": [852898575.9719942, 147.24075162398873, 200000], "duration": 402637, "rtol": 1e-10, "burns": [{"start": 3332.3330084835907, "duration": 337.9775568393046, "engine": 0, "direction": [1, 0.008838802800720389, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852917351.9485116, 64.35793963114483, 200000], "duration": 407130, "rtol": 1e-10, "burns": [{"start": 4346.667684672528, "duration": 337.467881238235, "engine": 0, "direction": [1, 0.021221649987728415, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852915418.8706818, 99.29448635130677, 200000], "duration": 405800, "rtol": 1e-10, "burns": [{"start": 3720.510138566574, "duration": 337.6206180645113, "engine": 0, "direction": [1, 0.008614733208443897, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852897460.7363927, 78.37053113176117, 200000], "duration": 371827, "rtol": 1e-10, "burns": [{"start": 4133.111154162392, "duration": 338.0888057035662, "engine": 0, "direction": [1, 0.011008215205874292, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852869562.4198723, 62.30993936678006, 200000], "duration": 428770, "rtol": 1e-10, "burns": [{"start": 3114.6408148002383, "duration": 337.0716419993184, "engine": 0, "direction": [1, 0.000957208406791758, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'lunar-free-return': {
    'cape-canaveral': {"params": [852906603.6786397, 81.66648753114096, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 1982.8800108797268, "duration": 339.0392530356967, "engine": 0, "direction": [1, 0.020874061657826563, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'vandenberg': {"params": [852898575.9719942, 147.24075162398873, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 3330.249675150258, "duration": 338.10255683930467, "engine": 0, "direction": [1, 5.4694673870554615e-06, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [852917351.9485116, 64.35793963114483, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 4386.667684672528, "duration": 338.467881238235, "engine": 0, "direction": [1, 0.04122164998772841, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [852915418.8706818, 99.29448635130677, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 3743.843471899908, "duration": 337.95395139784466, "engine": 0, "direction": [1, -5.1933458222769725e-05, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [852897460.7363927, 78.37053113176117, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 4173.111154162392, "duration": 339.0888057035662, "engine": 0, "direction": [1, 0.04100821520587429, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [852869562.4198723, 62.30993936678006, 200000], "duration": 1036800, "rtol": 1e-10, "burns": [{"start": 3034.6408148002383, "duration": 339.0716419993184, "engine": 0, "direction": [1, -0.02904279159320824, 0], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'lunar-orbit': {
    'cape-canaveral': {"params": [852906603.6786397, 81.66648753114096, 200000], "duration": 317189.528778553, "rtol": 1e-10, "burns": [{"start": 1569.190995895763, "duration": 1011.0678116323952, "engine": 0, "direction": [1, 0.01773799192526777, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 187506.63215817325, "duration": 165.79324075952172, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'vandenberg': {"params": [852898575.9719942, 147.24075162398873, 200000], "duration": 446181.5700931549, "rtol": 1e-10, "burns": [{"start": 2988.2039953698695, "duration": 992.2462809864041, "engine": 0, "direction": [1, 0.012459822518333018, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 316522.63267326914, "duration": 117.87483977153897, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'baikonur': {"params": [852917351.9485116, 64.35793963114483, 200000], "duration": 446278.04632663727, "rtol": 1e-10, "burns": [{"start": 4035.386582860739, "duration": 991.8647072614772, "engine": 0, "direction": [1, 0.024937483933029102, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 316620.81702579744, "duration": 114.45860167965293, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'tanegashima': {"params": [852915418.8706818, 99.29448635130677, 200000], "duration": 447661.5596232414, "rtol": 1e-10, "burns": [{"start": 3377.7070812879483, "duration": 991.1620090053805, "engine": 0, "direction": [1, 0.017747743201045607, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 318006.9597644862, "duration": 109.19971751049161, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'mahia': {"params": [852897460.7363927, 78.37053113176117, 200000], "duration": 422162.0244321823, "rtol": 1e-10, "burns": [{"start": 3827.378793189021, "duration": 992.9089956418666, "engine": 0, "direction": [1, 0.013794368740284425, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 292507.98731563054, "duration": 108.07423310354352, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
    'equator': {"params": [852869562.4198723, 62.30993936678006, 200000], "duration": 329648.74326491356, "rtol": 1e-10, "burns": [{"start": 2612.834430931022, "duration": 1006.8491146759724, "engine": 0, "direction": [1, 0.010980369779254366, 0], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 199971.60452225804, "duration": 154.27748531103134, "engine": 0, "direction": [-1, 0, 0], "frame": {"kind": "orbital", "body": "moon"}}]},
  },
  'venus-flyby': {
    'vandenberg': {"params": [890868499.473572, 147.2407538670532, 200000], "duration": 14959700.043057203, "rtol": 1e-11, "burns": [{"start": 12403.407062649727, "duration": 416.00333470427677, "engine": 0, "direction": [0.9941855476217776, -0.10070236975797675, 0.038133051610299805], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [890802679.198123, 52.81016095975712, 200000], "duration": 15025305.269194126, "rtol": 1e-11, "burns": [{"start": 73263.7533698082, "duration": 414.93256504025237, "engine": 0, "direction": [0.9964542038106092, -0.08409797557793545, 0.002559338167970097], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [890795791.9214358, 63.095938249375386, 200000], "duration": 15025181.224187374, "rtol": 1e-11, "burns": [{"start": 82607.22031855583, "duration": 424.32558819586757, "engine": 0, "direction": [0.962505118258119, -0.2710869447494788, -0.00978599577545923], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [890867662.7529619, 113.3282967545251, 200000], "duration": 14960342.757551908, "rtol": 1e-11, "burns": [{"start": 8202.032902002335, "duration": 413.97923623730344, "engine": 0, "direction": [0.9999270428284766, -0.011643941822142198, 0.003213664441192446], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [890818435.0939722, 78.37050527022632, 200000], "duration": 15009159.559862018, "rtol": 1e-11, "burns": [{"start": 58408.23498547077, "duration": 416.71917539054454, "engine": 0, "direction": [0.9898134541774525, -0.14227127836307546, -0.00531124112016061], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [890831499.7651038, 127.50000293984927, 200000], "duration": 14996500.841426134, "rtol": 1e-11, "burns": [{"start": 49503.194343566895, "duration": 414.6489855752443, "engine": 0, "direction": [0.9974837217900456, -0.070855275256812, 0.0023989022823267554], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'mars-flyby': {
    'vandenberg': {"params": [912345869.8458066, 147.24075525794575, 200000], "duration": 27881597.204310417, "rtol": 1e-11, "burns": [{"start": 81074.65809357166, "duration": 876.1360441463403, "engine": 0, "direction": [0.9335642495339243, -0.3487364627462598, 0.08270835231938393], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [912365209.3196752, 60.921914146122, 200000], "duration": 27450745.670203924, "rtol": 1e-11, "burns": [{"start": 62355.524217009544, "duration": 837.499041280689, "engine": 0, "direction": [0.9946615787252774, -0.09840874967600836, -0.031049344517131067], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [912360396.2686238, 63.09595905276993, 200000], "duration": 28313578.50318587, "rtol": 1e-11, "burns": [{"start": 66270.06953465939, "duration": 911.8459366543646, "engine": 0, "direction": [0.8751768024874843, -0.48133014413925984, 0.0488554677662825], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [912347894.5670135, 99.29453142734073, 200000], "duration": 27466257.593600035, "rtol": 1e-11, "burns": [{"start": 76707.08701741695, "duration": 842.5661952866726, "engine": 0, "direction": [0.9851964495454861, -0.1665029958137636, -0.040800835628823806], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [912385462.8356087, 78.37051335060146, 200000], "duration": 27430351.16861725, "rtol": 1e-11, "burns": [{"start": 41957.25314962864, "duration": 844.0677155381146, "engine": 0, "direction": [0.9832725407477189, -0.1795622761005084, -0.030536856634738905], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [912393444.2091343, 119.50000567586572, 200000], "duration": 27422512.391710877, "rtol": 1e-11, "burns": [{"start": 33323.41449320316, "duration": 836.7916854501058, "engine": 0, "direction": [0.9959933107948503, -0.08421237741293289, -0.030093194286661767], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'mars-orbit': {
    'vandenberg': {"params": [911828317.7618377, 147.2407559621542, 200000], "duration": 26257177.876528263, "rtol": 1e-11, "burns": [{"start": 81199.2895834446, "duration": 510.7749583743942, "engine": 0, "direction": [0.9591886980228816, -0.28084150748660847, -0.03294069303791721], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23406226.797652245, "duration": 0.016656388751649848, "engine": 0, "direction": [-0.9392184100139397, -0.2830348307063146, -0.194319486665478], "frame": {"kind": "inertial"}}, {"start": 25997933.365381647, "duration": 89.0222932345034, "engine": 0, "direction": [-1207.7881435564464, -1.0487130452929705e-06, 0.0007221948166602488], "frame": {"kind": "orbital", "body": "mars"}}]},
    'kourou': {"params": [911847031.1228235, 60.92191392450457, 200000], "duration": 26236257.503690243, "rtol": 1e-11, "burns": [{"start": 62584.69108903408, "duration": 498.6430206969647, "engine": 0, "direction": [0.995696856460731, -0.09258731129048355, 0.00391916090734285], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23752812.850046873, "duration": 0.07923769454588292, "engine": 0, "direction": [0.07639435619680975, -0.8571514079359907, 0.5093676140221557], "frame": {"kind": "inertial"}}, {"start": 25977011.574718636, "duration": 91.85794321381087, "engine": 0, "direction": [-1206.9699847080092, -1.2756126466229034e-06, 0.000877334988928169], "frame": {"kind": "orbital", "body": "mars"}}]},
    'baikonur': {"params": [911842815.2402749, 63.09595802410316, 200000], "duration": 26238404.808095455, "rtol": 1e-11, "burns": [{"start": 66447.2211523056, "duration": 509.8560695136056, "engine": 0, "direction": [0.9620087838427223, -0.2723143613020781, -0.01959562293186606], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23793541.93017447, "duration": 0.06921656152423553, "engine": 0, "direction": [0.10021498896141369, -0.8847381710100379, 0.4551871315681901], "frame": {"kind": "inertial"}}, {"start": 25979160.205892865, "duration": 89.2044051778685, "engine": 0, "direction": [-1207.3940353196133, -1.063566514858394e-06, 0.0007316923145310739], "frame": {"kind": "orbital", "body": "mars"}}]},
    'tanegashima': {"params": [911830084.3866539, 99.29453261225005, 200000], "duration": 26257379.086288214, "rtol": 1e-11, "burns": [{"start": 76925.0165938139, "duration": 501.73090528824656, "engine": 0, "direction": [0.9863685219632872, -0.1644677558506952, 0.005243678612981617], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23406438.6478858, "duration": 0.01669823859242542, "engine": 0, "direction": [-0.9199380962098054, -0.3290092232608365, -0.21322952457664074], "frame": {"kind": "inertial"}}, {"start": 25998133.508960936, "duration": 91.15465455458884, "engine": 0, "direction": [-1207.2845041385408, -1.2190292864033836e-06, 0.0008393761188614235], "frame": {"kind": "orbital", "body": "mars"}}]},
    'mahia': {"params": [911867830.4879844, 78.3705125422205, 200000], "duration": 26218153.801764727, "rtol": 1e-11, "burns": [{"start": 42154.73626923561, "duration": 502.50306118920423, "engine": 0, "direction": [0.9841722133710292, -0.1771796873953644, -0.003523180785933245], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23367922.487380147, "duration": 0.41717250583120324, "engine": 0, "direction": [0.20895226373858694, -0.9777994123956423, -0.015724522163063682], "frame": {"kind": "inertial"}}, {"start": 25958908.394658454, "duration": 90.81421254234684, "engine": 0, "direction": [-1206.3711602838252, -1.1876637131535972e-06, 0.0008156658417703966], "frame": {"kind": "orbital", "body": "mars"}}]},
    'equator': {"params": [911875266.0121255, 119.50000577720358, 200000], "duration": 26206772.0737741, "rtol": 1e-11, "burns": [{"start": 33551.04805934429, "duration": 498.3587271652463, "engine": 0, "direction": [0.9965540960921685, -0.08289135280003473, 0.0029928569797356705], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 23355775.6901623, "duration": 0.04036164044188467, "engine": 0, "direction": [-0.030741433831307143, -0.8864656072502464, 0.46177233720573563], "frame": {"kind": "inertial"}}, {"start": 25947526.103816904, "duration": 91.9399143900333, "engine": 0, "direction": [-1207.0400427718353, -1.2816122989534051e-06, 0.000881500212230435], "frame": {"kind": "orbital", "body": "mars"}}]},
  },
  'venus-to-mercury': {
    'vandenberg': {"params": [1003970580.9190273, 147.24074480488966, 200000], "duration": 29030662.276712894, "rtol": 1e-11, "burns": [{"start": 33122.44298493862, "duration": 605.1900140431253, "engine": 0, "direction": [0.9977641717586158, -0.06682836589107696, 0.0007918757300504152], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 13995308.006934762, "duration": 1.62782220298901, "engine": 0, "direction": [-0.32854041871464523, 0.04387946630794741, 0.9434700767418833], "frame": {"kind": "inertial"}}]},
    'kourou': {"params": [1003938244.9466674, 82.04125374720093, 200000], "duration": 29061902.723641515, "rtol": 1e-11, "burns": [{"start": 65706.68633139133, "duration": 604.2634525176874, "engine": 0, "direction": [0.9996569996654149, -0.026189148392974645, -0.00010736103463080674], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 14130424.983689547, "duration": 1.3932042299653622, "engine": 0, "direction": [-0.3623282072616421, 0.07553424036717807, 0.9289848485065394], "frame": {"kind": "inertial"}}]},
    'baikonur': {"params": [1003988124.4056897, 63.0959761879292, 200000], "duration": 29014040.743870497, "rtol": 1e-11, "burns": [{"start": 18267.915967583656, "duration": 604.7490441407499, "engine": 0, "direction": [0.9988492438068017, -0.04795451505013485, 0.0007433928211707409], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 13977903.465743303, "duration": 1.689583519777021, "engine": 0, "direction": [-0.2942772658737076, -0.012047365565321579, 0.9556441554118513], "frame": {"kind": "inertial"}}]},
    'tanegashima': {"params": [1003986457.8870366, 99.29447672128718, 200000], "duration": 29013467.09006405, "rtol": 1e-11, "burns": [{"start": 17600.099305272102, "duration": 604.5067552992646, "engine": 0, "direction": [0.9992021597872427, -0.03993484613073222, 0.000501937270908706], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 13979566.599715829, "duration": 1.455566149205597, "engine": 0, "direction": [-0.34543362167935054, 0.06955903203211285, 0.935861717390044], "frame": {"kind": "inertial"}}]},
    'mahia': {"params": [1003931197.909564, 78.37057374550328, 200000], "duration": 29072752.811205387, "rtol": 1e-11, "burns": [{"start": 73402.23155450821, "duration": 608.3789303055403, "engine": 0, "direction": [0.9874523145698125, -0.15787107984832027, -0.0038273487227176296], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 14039211.895939946, "duration": 1.7318237928625901, "engine": 0, "direction": [-0.2671108311352156, -0.016966051374926468, 0.9635164539285241], "frame": {"kind": "inertial"}}]},
    'equator': {"params": [1003960804.753722, 99.50000046882863, 200000], "duration": 29042741.551178098, "rtol": 1e-11, "burns": [{"start": 47626.877579689026, "duration": 604.2033318448044, "engine": 0, "direction": [0.9997995035898797, -0.020023478692556124, 0.00011367708282399373], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 14005111.73397696, "duration": 1.6815837110371392, "engine": 0, "direction": [-0.268171282636087, -0.04351155229277468, 0.9623881275173697], "frame": {"kind": "inertial"}}]},
  },
  'solar-escape': {
    'vandenberg': {"params": [983020021.7178533, 147.24073829281943, 200000], "duration": 71774031.59474182, "rtol": 1e-11, "burns": [{"start": 59329.747121691704, "duration": 769.6847618452148, "engine": 0, "direction": [0.9968593887999296, -0.07918405224591946, 0.0011157201020940942], "frame": {"kind": "orbital", "body": "earth"}}]},
    'kourou': {"params": [983067121.242728, 57.874185983195375, 200000], "duration": 71726932.19798493, "rtol": 1e-11, "burns": [{"start": 12875.68834578991, "duration": 768.9031213361997, "engine": 0, "direction": [0.9985629372770007, -0.05358475160686512, 0.000857141738269482], "frame": {"kind": "orbital", "body": "earth"}}]},
    'baikonur': {"params": [983039675.0505121, 63.09598805422574, 200000], "duration": 71754378.47787023, "rtol": 1e-11, "burns": [{"start": 44403.046066880226, "duration": 769.6641415801452, "engine": 0, "direction": [0.9968010245018366, -0.07989169583695759, 0.0022437665618094483], "frame": {"kind": "orbital", "body": "earth"}}]},
    'tanegashima': {"params": [983048418.8551605, 102.53421820050505, 200000], "duration": 71745634.88786435, "rtol": 1e-11, "burns": [{"start": 32619.127549886703, "duration": 769.0268612364245, "engine": 0, "direction": [0.9982410566385368, -0.059276548838000966, 0.0010409606301552657], "frame": {"kind": "orbital", "body": "earth"}}]},
    'mahia': {"params": [983072122.541208, 78.37053833572699, 200000], "duration": 71721931.0592792, "rtol": 1e-11, "burns": [{"start": 9167.019684314728, "duration": 768.9051513250863, "engine": 0, "direction": [0.9987955473709803, -0.049015659645631086, 0.002218030975374553], "frame": {"kind": "orbital", "body": "earth"}}]},
    'equator': {"params": [983052524.0546336, 57.50000416609769, 200000], "duration": 71741529.3501296, "rtol": 1e-11, "burns": [{"start": 28940.042837500572, "duration": 769.0122195001754, "engine": 0, "direction": [0.9982730016874499, -0.058737219966473526, 0.0009762645844398934], "frame": {"kind": "orbital", "body": "earth"}}]},
  },
  'jupiter-saturn': {
    'vandenberg': {"params": [1088253771.357909, 147.24075280711827, 200000], "duration": 201911695.5695479, "rtol": 1e-11, "burns": [{"start": 59917.703176259995, "duration": 772.3960821053097, "engine": 0, "direction": [0.9905455506070573, -0.1371828829903779, -0.0006072783627280631], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101425746.77425838, "duration": 3.5821958690291678, "engine": 0, "direction": [-0.005823728238367018, 0.8037434983627474, 0.5949474540066697], "frame": {"kind": "inertial"}}]},
    'kourou': {"params": [1088295545.5338378, 86.10013114769708, 200000], "duration": 201859933.02153254, "rtol": 1e-11, "burns": [{"start": 18823.45995235443, "duration": 768.6899202613763, "engine": 0, "direction": [0.9974113674068336, -0.013575915901209415, -0.07061344542701306], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101383606.70707941, "duration": 3.6365653387437296, "engine": 0, "direction": [-0.010528109160142796, 0.7778955659425876, 0.6283053775071272], "frame": {"kind": "inertial"}}]},
    'baikonur': {"params": [1088270608.0449214, 63.095968191550156, 200000], "duration": 201893658.88713408, "rtol": 1e-11, "burns": [{"start": 39776.61688256264, "duration": 771.3795227192562, "engine": 0, "direction": [0.9932555168976714, -0.11590859408141765, -0.002945500026983894], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101408951.58973503, "duration": 3.596325543972605, "engine": 0, "direction": [-0.0058136767842458, 0.8010492507482347, 0.5985702122875313], "frame": {"kind": "inertial"}}]},
    'tanegashima': {"params": [1088266927.5297356, 99.29448823478512, 200000], "duration": 201890303.8289032, "rtol": 1e-11, "burns": [{"start": 44501.22145938873, "duration": 770.4725639915617, "engine": 0, "direction": [0.9951656234120323, -0.09748818893249656, -0.011892644684973547], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101412730.70031643, "duration": 3.600954436313766, "engine": 0, "direction": [-0.01086856420023754, 0.7913146525186505, 0.6113125182928228], "frame": {"kind": "inertial"}}]},
    'mahia': {"params": [1088298946.835103, 78.3705303804029, 200000], "duration": 201896397.85186243, "rtol": 1e-11, "burns": [{"start": 15327.181068658829, "duration": 769.7004121164537, "engine": 0, "direction": [0.9975201088129722, -0.06921483067788199, -0.01276478468241555], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101380030.16531205, "duration": 3.6889801506685163, "engine": 0, "direction": [0.02300863370277812, 0.7968637226552892, 0.6037208049182051], "frame": {"kind": "inertial"}}]},
    'equator': {"params": [1088301936.4529715, 91.4999984253619, 200000], "duration": 201862697.07925177, "rtol": 1e-11, "burns": [{"start": 12350.235082864761, "duration": 768.6362010878129, "engine": 0, "direction": [0.9976852383374676, 5.151990311148625e-05, -0.06800119520427755], "frame": {"kind": "orbital", "body": "earth"}}, {"start": 101377089.31160164, "duration": 3.6584355652260507, "engine": 0, "direction": [-0.0016031494480977433, 0.7765522802305204, 0.6300507804777539], "frame": {"kind": "inertial"}}]},
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
