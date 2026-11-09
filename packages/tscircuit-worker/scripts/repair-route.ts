import { parseArgs } from "node:util";
import { mkdir, writeFile, readFile, cp, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildProject, snapshotProject } from "../src/build.js";
import { applyPlacementMove, planRoutingRepair } from "../src/routing-repair.js";

/** Bounded and supervised PCB candidate loop, never a release authorizer. */
const {values}=parseArgs({options:{
  project:{type:"string"},
  output:{type:"string"},
  attempts:{type:"string",default:"3"},
  "native-check":{type:"boolean",default:false},
},strict:true});
if(!values.project||!values.output)throw new Error("Usage: --project <existing-project> --output <fresh-build-dir> [--attempts 1..3] [--native-check]");
const max=Number(values.attempts);
if(!Number.isInteger(max)||max<1||max>3)throw new Error("REPAIR_LIMIT: attempts must be between 1 and 3");
const sourceRoot=path.resolve(values.project);
const outRoot=path.resolve(values.output);
if(outRoot===sourceRoot||outRoot.startsWith(sourceRoot+path.sep))throw new Error("REPAIR_INVALID: output cannot be inside source project");
await snapshotProject(sourceRoot); // validates all source files before a candidate is copied
try { await stat(outRoot); throw new Error("REPAIR_OUTPUT_EXISTS: existing attempt directory will not be overwritten");}
catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
await mkdir(outRoot,{recursive:true});
const records:Array<Record<string,unknown>>=[];
let nextSource=sourceRoot;
let status:"source_error"|"placement_blocked"|"native_blocked"|"routing_candidate"="source_error";
try {
  for(let iteration=0;iteration<max;iteration++) {
    const resultDir=path.join(outRoot,"build-"+iteration);
    const record:Record<string,unknown>={attempt:iteration,project:nextSource,build:resultDir};
    records.push(record);
    let built;
    try{built=await buildProject({projectRoot:nextSource,outputDir:resultDir});}
    catch(error){record.status="source_error";record.error=String(error);status="source_error";break;}
    const json=JSON.parse(await readFile(built.circuitJsonPath,"utf8"));
    const constraints=JSON.parse(await readFile(path.join(nextSource,"pcb.constraints.json"),"utf8"));
    const plan=planRoutingRepair(json,constraints);
    record.placement_plan=plan;
    record.routing={traces:json.filter((item:any)=>item.type==="pcb_trace").length,
      vias:json.filter((item:any)=>item.type==="pcb_via").length,
      source_error_count:plan.source_error_count};
    if(plan.status==="repair-proposed" && plan.moves.length===1 && iteration+1<max) {
      const candidateDir=path.join(outRoot,"project-"+(iteration+1));
      await cp(nextSource,candidateDir,{recursive:true,force:false,errorOnExist:true});
      const matchingFiles=(await import("node:fs/promises")).readdir;
      // Search local TSX modules recursively; update exactly one match.
      async function walk(dir:string):Promise<string[]>{
        const items=await matchingFiles(dir,{withFileTypes:true});
        return (await Promise.all(items.map(async e=> e.isDirectory()?walk(path.join(dir,e.name)):
          e.isFile()&&e.name.endsWith(".tsx")?[path.join(dir,e.name)]:[]))).flat();
      }
      let count=0;const changed:string[]=[];
      for(const file of await walk(path.join(candidateDir,"src"))) {
        const before=await readFile(file,"utf8");
        try {
          const after=applyPlacementMove(before,plan.moves[0]);
          if(after!==before){await writeFile(file,after);count++;changed.push(path.relative(candidateDir,file));}
        }catch(error) {
          if(!String(error).includes("REPAIR_AMBIGUOUS: component must appear exactly once")) throw error;
        }
      }
      if(count!==1){record.status="placement_blocked";record.error="REPAIR_AMBIGUOUS: move targets "+count+" component declarations";status="placement_blocked";break;}
      record.status="candidate_generated";
      record.modified_source_files=changed;
      nextSource=candidateDir;
      continue;
    }
    if(plan.status!=="no-errors") {
      record.status="placement_blocked";
      record.error=plan.blockers.length?plan.blockers:["Placement repair exhausted allowed attempts"];
      status="placement_blocked";break;
    }
    if(values["native-check"]) {
      const here=path.dirname(fileURLToPath(import.meta.url));
      const checker=path.join(here,"verify-project.ts");
      const subprocess=spawnSync(process.execPath,["--import","tsx",checker,"--build",resultDir],
        {cwd:path.resolve(here,".."),encoding:"utf8",timeout:180_000,maxBuffer:1024*1024,windowsHide:true});
      record.native_exit_code=subprocess.status;
      record.native_output=(subprocess.stdout||"").slice(-10000);
      if(subprocess.error||subprocess.status!==0) {
        record.status="native_blocked";record.native_stderr=(subprocess.stderr||"").slice(-2000);
        status="native_blocked";break;
      }
      const check=JSON.parse(await readFile(path.join(resultDir,"native-check","verification-summary.json"),"utf8"));
      record.native_check=check.status;
      record.release_gate=check.release_gate;
      status=check.release_gate.ready?"routing_candidate":"native_blocked";
      record.status=status;
      break;
    }
    status="routing_candidate"; record.status=status;
    break;
  }
}finally {
  const summary={schema_version:1,status,
    release_approved:false, // The loop cannot authorize manufacturing
    original_project:sourceRoot,attempts:records};
  await writeFile(path.join(outRoot,"repair-history.json"),JSON.stringify(summary,null,2)+"\n");
  process.stdout.write(JSON.stringify({
    history:path.join(outRoot,"repair-history.json"),
    status,iterations:records.length,
    final:records.at(-1)?.routing,
  },null,2)+"\n");
}
if(status!=="routing_candidate")process.exitCode=1;
