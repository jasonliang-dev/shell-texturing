struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) m: vec2f,
  @location(1) nw: vec2f,
  @location(2) ne: vec2f,
  @location(3) sw: vec2f,
  @location(4) se: vec2f,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var surface: texture_2d<f32>;
@group(0) @binding(2) var surfaceSampler: sampler;

@vertex fn vp(@builtin(vertex_index) i: u32) -> VertexOut {
  var out: VertexOut;

  let uv = vec2f(vec2(i & 2, (i << 1) & 2));
  out.position = vec4f(uv * vec2f(2, -2) + vec2f(-1, 1), 0, 1);

  let texel = uv * u.screenResolution;
  out.nw = (texel + vec2f(-1, -1)) / u.screenResolution;
  out.ne = (texel + vec2f(1, -1)) / u.screenResolution;
  out.sw = (texel + vec2f(-1, 1)) / u.screenResolution;
  out.se = (texel + vec2f(1, 1)) / u.screenResolution;
  out.m = uv;

  return out;
}

@fragment fn fp(in: VertexOut) -> @location(0) vec4f {
  let FXAA_REDUCE_MIN = 1.0 / 128.0;
  let FXAA_REDUCE_MUL = 1.0 / 8.0;
  let FXAA_SPAN_MAX = 8.0;

  let luma = vec3f(0.299, 0.587, 0.114);

  let lumaNW = dot(textureSample(surface, surfaceSampler, in.nw).xyz, luma);
  let lumaNE = dot(textureSample(surface, surfaceSampler, in.ne).xyz, luma);
  let lumaSW = dot(textureSample(surface, surfaceSampler, in.sw).xyz, luma);
  let lumaSE = dot(textureSample(surface, surfaceSampler, in.se).xyz, luma);
  let lumaM = dot(textureSample(surface, surfaceSampler, in.m).xyz, luma);

  var dir: vec2f;
  dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
  dir.y = (lumaNW + lumaSW) - (lumaNE + lumaSE);

  let reduce = max(FXAA_REDUCE_MIN, (lumaNW + lumaNE + lumaSW + lumaSE) * (0.25 * FXAA_REDUCE_MUL));

  var rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = max(vec2f(-FXAA_SPAN_MAX, -FXAA_SPAN_MAX), dir * rcpDirMin);
  dir = min(vec2f(FXAA_SPAN_MAX, FXAA_SPAN_MAX), dir);
  dir /= u.screenResolution;

  let lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  let lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

  var rgbA = textureSample(surface, surfaceSampler, in.m + dir * (1.0 / 3.0 - 0.5)).xyz;
  rgbA += textureSample(surface, surfaceSampler, in.m + dir * (2.0 / 3.0 - 0.5)).xyz;
  rgbA *= 0.5;

  var rgbB = textureSample(surface, surfaceSampler, in.m + dir * -0.5).xyz;
  rgbB += textureSample(surface, surfaceSampler, in.m + dir * 0.5).xyz;
  rgbB = rgbA * 0.5 + 0.25 * rgbB;

  var lumaB = dot(rgbB, luma);
  if (lumaB < lumaMin || lumaB > lumaMax) {
    return vec4f(rgbA, 1.0);
  } else {
    return vec4f(rgbB, 1.0);
  }
}
