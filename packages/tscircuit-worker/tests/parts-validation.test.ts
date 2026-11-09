import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveParts } from "../src/parts-validation.js";
const catalog = JSON.parse(await readFile(new URL("../../../models/vendor-catalog.json", import.meta.url),"utf8"));
const graph = [
  {type:"source_component",source_component_id:"q1",name:"Q1",ftype:"simple_mosfet"},
  ...[["gate",1],["source",2],["drain",3]].map(([name,pin_number],i)=>({type:"source_port",source_component_id:"q1",source_port_id:"p"+i,name,pin_number})),
];
const lock = {schema_version:1,status:"partially_verified",parts:[{reference:"Q1",manufacturer_part_number:"2N7002-7-F",footprint:"sot23",pin_map_status:"datasheet_reviewed",simulation_model_id:"diodes-2n7002-2017"}]};
test("part lock binds exact manufacturer model terminal order to physical package pins",()=>{
  const r=resolveParts(graph,lock,catalog);
  assert.equal(r.status,"verified");
  assert.deepEqual(r.entries[0].physical_pins,["1","2","3"]);
  assert.equal(r.entries[0].model_verified,true);
});
test("part lock fails closed on swapped gate and drain pins",()=>{
  const wrong=graph.map(x=>x.type==="source_port"&&x.name==="drain"?{...x,pin_number:1}:x.type==="source_port"&&x.name==="gate"?{...x,pin_number:3}:x);
  assert.throws(()=>resolveParts(wrong,lock,catalog),/PARTS_PIN_MISMATCH/);
});
test("unknown vendor model and missing source reference are rejected",()=>{
  assert.throws(()=>resolveParts(graph,{...lock,parts:[{...lock.parts[0],simulation_model_id:"bad-model"}]},catalog),/PARTS_MODEL_UNKNOWN/);
  assert.throws(()=>resolveParts(graph,{...lock,parts:[]},catalog),/PARTS_INVALID/);
});
test("missing sourcing and unverified pin data are reported without implying verification",()=>{
  const r=resolveParts(graph,{...lock,parts:[{...lock.parts[0],simulation_model_id:undefined,pin_map_status:"unverified"}]},catalog);
  assert.equal(r.status,"unverified");
  assert.ok(r.unresolved.length);
});
