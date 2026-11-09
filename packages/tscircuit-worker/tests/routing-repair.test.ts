import test from "node:test";
import assert from "node:assert/strict";
import {applyPlacementMove,planRoutingRepair} from "../src/routing-repair.js";
const board = {type:"pcb_board",center:{x:0,y:0},width:36,height:24,min_board_edge_clearance:0.2};
const source = {type:"source_component",source_component_id:"s1",name:"R2"};
const physical = {type:"pcb_component",pcb_component_id:"p2",source_component_id:"s1"};
const off = {type:"pcb_component_outside_board_error",pcb_component_id:"p2",component_bounds:{min_x:17,max_x:18.6,min_y:-1,max_y:1}};
const constraints={board:{width_mm:36,height_mm:24,layers:2},fixed_components:["J1"]};
test("real geometry error produces bounded component translation",()=>{
 const p=planRoutingRepair([board,source,physical,off],constraints);
 assert.equal(p.status,"repair-proposed");
 assert.equal(p.moves[0].reference,"R2");
 assert.ok(p.moves[0].dx_mm<0);
 const changed=applyPlacementMove('<resistor name="R2" resistance="1k" pcbX={17} pcbY={0} />',p.moves[0]);
 assert.match(changed,/pcbX=\{16\./);
});
test("fixed component placement errors cannot be silently changed",()=>{
 const p=planRoutingRepair([board,{...source,name:"J1"},physical,off],constraints);
 assert.equal(p.status,"blocked");
 assert.match(p.blockers.join(" "),/fixed component/);
});
test("unsupported electrical or DRC errors require separate human/agent repair",()=>{
 const p=planRoutingRepair([board,source,physical,{type:"pcb_short_error"}],constraints);
 assert.equal(p.status,"blocked");
});
test("source connectivity with no generated PCB copper is not a routing candidate",()=>{
 const p=planRoutingRepair([board,{type:"source_trace"}],constraints);
 assert.equal(p.status,"blocked");
 assert.match(p.blockers.join(" "),/no PCB copper traces/i);
});
test("JSX repair refuses ambiguous or implicit placement",()=>{
 assert.throws(()=>applyPlacementMove('<resistor name="R2" />',{reference:"R2",dx_mm:1,dy_mm:0,reason:""}),/finite numeric/);
});
