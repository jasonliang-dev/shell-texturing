struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) texcoord: vec2f,
}

@vertex fn vp(@builtin(vertex_index) i: u32) -> VertexOut {
  var out: VertexOut;

  let uv = vec2f(vec2(i & 2, (i << 1) & 2));
  let pos = vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1);

  out.position = pos.xyww;
  out.texcoord = uv;
  return out;
}

@fragment fn fp(in: VertexOut) -> @location(0) vec4f {
  let top = vec4f(0.7, 0.8, 0.9, 1.0);
  let bot = vec4f(0.5, 0.7, 0.9, 1.0);
  return mix(top, bot, in.texcoord.y);
}
