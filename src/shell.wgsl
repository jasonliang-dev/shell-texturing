struct VertexIn {
  @builtin(instance_index) instance: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) texcoord: vec2f,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) texcoord: vec2f,
  @location(2) @interpolate(flat) instance: u32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<uniform> shellCount: f32;

fn random(uv: vec2f) -> f32 {
  return fract(sin(dot(uv.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

fn steepCos(angle: f32, slope: f32) -> f32 {
  return atan(slope * cos(angle)) / atan(slope);
}

@vertex fn vp(in: VertexIn) -> VertexOut {
  var out: VertexOut;

  let scale = 1 + f32(in.instance) * 0.001;
  let height = f32(in.instance) / shellCount;
  let position = in.position * scale + vec3f(0, -height * 0.02, 0);

  out.position = u.cameraProjection * u.cameraView * vec4f(position, 1);
  out.normal = in.normal;
  out.texcoord = in.texcoord;
  out.instance = in.instance;
  return out;
}

@fragment fn fp(in: VertexOut) -> @location(0) vec4f {
  let uv = in.texcoord * 256;

  let height = f32(in.instance) / shellCount;

  let cell = floor(uv);
  let local = (uv - cell) * 2 - 1;
  if ((random(cell) - height) * 4 < length(local)) {
    discard;
  }

  let light = normalize(vec3f(1, 1, 0));

  let ambient = 0.4;
  let diffuse = dot(light, in.normal) * 0.5 + 0.5;
  let lighting = vec3f((ambient + diffuse) * height);

  let yellow = steepCos(in.texcoord.y * 14, 2) * 0.5 + 0.5;
  let color = mix(vec3f(0.25, 0.15, 0.0), vec3f(1, 0.8, 0.1), yellow);

  return vec4f(color * lighting, 1);
}
