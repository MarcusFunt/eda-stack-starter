export function rcSourceManifestGraph() {
  const sourceComponents = [
    { source_component_id: "component_v1", name: "V1", ftype: "simple_voltage_source" },
    { source_component_id: "component_r1", name: "R1", ftype: "simple_resistor" },
    { source_component_id: "component_c1", name: "C1", ftype: "simple_capacitor" },
  ];
  const sourcePorts = [
    { source_port_id: "v1_pin1", source_component_id: "component_v1", name: "pin1" },
    { source_port_id: "v1_pin2", source_component_id: "component_v1", name: "pin2" },
    { source_port_id: "r1_pin1", source_component_id: "component_r1", name: "pin1" },
    { source_port_id: "r1_pin2", source_component_id: "component_r1", name: "pin2" },
    { source_port_id: "c1_pin1", source_component_id: "component_c1", name: "pin1" },
    { source_port_id: "c1_pin2", source_component_id: "component_c1", name: "pin2" },
  ];
  const sourceNets = [
    { source_net_id: "net_gnd", name: "GND" },
    { source_net_id: "net_in", name: "in" },
    { source_net_id: "net_out", name: "out" },
  ];
  return {
    source_components: sourceComponents,
    source_ports: sourcePorts,
    source_nets: sourceNets,
    source_traces: [
      { source_trace_id: "trace_v1_in", connected_source_port_ids: ["v1_pin1"], connected_source_net_ids: ["net_in"] },
      { source_trace_id: "trace_r1_in", connected_source_port_ids: ["r1_pin1"], connected_source_net_ids: ["net_in"] },
      { source_trace_id: "trace_r1_out", connected_source_port_ids: ["r1_pin2"], connected_source_net_ids: ["net_out"] },
      { source_trace_id: "trace_c1_out", connected_source_port_ids: ["c1_pin1"], connected_source_net_ids: ["net_out"] },
      { source_trace_id: "trace_return", connected_source_port_ids: ["c1_pin2", "v1_pin2"], connected_source_net_ids: [] },
      { source_trace_id: "trace_gnd", connected_source_port_ids: ["v1_pin2"], connected_source_net_ids: ["net_gnd"] },
    ],
    source_probes: [
      { name: "VOUT", signal_input_source_port_id: "c1_pin1", reference_input_source_net_id: "net_gnd" },
      { name: "VIN", signal_input_source_port_id: "v1_pin1", reference_input_source_net_id: "net_gnd" },
    ],
    converted_probes: [
      { name: "VOUT", source_node_name: "N2" },
      { name: "VIN", source_node_name: "N1" },
    ],
  };
}
