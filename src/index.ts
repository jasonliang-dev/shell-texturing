import { Mat4, Vec3, mat4, vec2, vec3 } from "wgpu-matrix";
import OBJLoader, { OBJLoadResult } from "./obj-loader";
import skyWGSL from "./sky.wgsl";
import shellWGSL from "./shell.wgsl";
import fxaaWGSL from "./fxaa.wgsl";

const RADIANS = Math.PI / 180;
const SIZE_UINT16 = 2;
const SIZE_FLOAT = 4;
const SIZE_VEC4 = 4 * SIZE_FLOAT;
const SIZE_MAT4 = 16 * SIZE_FLOAT;

let device: GPUDevice;
let presentationFormat: GPUTextureFormat;
let cache: RenderCache;
let instrument: Instrument | undefined;

let uniformsWGSL: string;
let ubuf: GPUBuffer;

const keyboard: { [key: string]: boolean } = {};

const mouse = {
  x: 0,
  y: 0,
  prevX: 0,
  prevY: 0,
  deltaX: 0,
  deltaY: 0,
  button0: false,
  button1: false,
  button2: false,
  wheel: 0,
};

addEventListener("keydown", (e) => {
  keyboard[e.code] = true;
});

addEventListener("keyup", (e) => {
  keyboard[e.code] = false;
});

addEventListener("mousedown", (e) => {
  if (e.button === 0) {
    mouse.button0 = true;
  } else if (e.button === 1) {
    mouse.button1 = true;
  } else if (e.button === 2) {
    mouse.button2 = true;
  }
});

addEventListener("mouseup", (e) => {
  if (e.button === 0) {
    mouse.button0 = false;
  } else if (e.button === 1) {
    mouse.button1 = false;
  } else if (e.button === 2) {
    mouse.button2 = false;
  }
});

addEventListener("wheel", (e) => {
  mouse.wheel = e.deltaY;
});

addEventListener("mousemove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});

function clamp(n: number, lo: number, hi: number) {
  if (n < lo) {
    return lo;
  } else if (n > hi) {
    return hi;
  } else {
    return n;
  }
}

class Camera {
  private yaw: number;
  private pitch = 0;

  private front = vec3.create();
  private right = vec3.create();
  private up = vec3.create();

  private positionA: Vec3;
  private positionB: Vec3;

  constructor(pos: Vec3, yaw: number) {
    this.positionA = vec3.clone(pos);
    this.positionB = vec3.clone(pos);
    this.yaw = yaw;
  }

  public update() {
    if (mouse.button0) {
      const sensitivity = 0.005;
      this.yaw += mouse.deltaX * sensitivity;
      this.pitch -= mouse.deltaY * sensitivity;
      this.pitch = clamp(this.pitch, -85 * RADIANS, 85 * RADIANS);
    }

    this.front[0] = Math.cos(this.yaw) * Math.cos(this.pitch);
    this.front[1] = Math.sin(this.pitch);
    this.front[2] = Math.sin(this.yaw) * Math.cos(this.pitch);
    vec3.normalize(this.front, this.front);

    vec3.normalize(vec3.cross(this.front, vec3.create(0, 1, 0)), this.right);
    vec3.normalize(vec3.cross(this.right, this.front), this.up);

    let forward = 0;
    let right = 0;
    let up = 0;

    let moveSpeed: number;
    if (keyboard.ShiftLeft) {
      moveSpeed = 0.1;
    } else {
      moveSpeed = 0.03;
    }

    if (keyboard.KeyW) {
      forward -= moveSpeed;
    }
    if (keyboard.KeyS) {
      forward += moveSpeed;
    }
    if (keyboard.KeyA) {
      right += moveSpeed;
    }
    if (keyboard.KeyD) {
      right -= moveSpeed;
    }
    if (keyboard.KeyQ) {
      up += moveSpeed;
    }
    if (keyboard.KeyE || keyboard.Space) {
      up -= moveSpeed;
    }

    vec3.add(
      this.positionB,
      vec3.mulScalar(this.front, -forward),
      this.positionB,
    );
    vec3.add(
      this.positionB,
      vec3.mulScalar(vec3.normalize(vec3.cross(this.front, this.up)), -right),
      this.positionB,
    );
    this.positionB[1] -= up;

    vec3.lerp(this.positionA, this.positionB, 0.2, this.positionA);
  }

  public view(dst?: Mat4) {
    return mat4.lookAt(
      this.positionA,
      vec3.add(this.positionA, this.front),
      this.up,
      dst,
    );
  }
}

class Model {
  private vbuf: GPUBuffer;
  private ibuf: GPUBuffer;
  private indexCount: number;

  private constructor(obj: OBJLoadResult) {
    const faceToVertexIndex = new Map<string, number>();

    const vertices: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < obj.faces.length; i += 3) {
      const v = obj.faces[i + 0];
      const vt = obj.faces[i + 1];
      const vn = obj.faces[i + 2];

      const key = (
        (BigInt(vn) << 32n) |
        (BigInt(vt) << 16n) |
        BigInt(v)
      ).toString();

      const entry = faceToVertexIndex.get(key);
      if (entry !== undefined) {
        indices.push(entry);
      } else {
        console.assert(vertices.length % 8 === 0);

        const index = vertices.length / 8;
        faceToVertexIndex.set(key, index);
        indices.push(index);

        vertices.push(obj.vertices[(v - 1) * 3 + 0]);
        vertices.push(obj.vertices[(v - 1) * 3 + 1]);
        vertices.push(obj.vertices[(v - 1) * 3 + 2]);

        vertices.push(obj.normals[(vn - 1) * 3 + 0]);
        vertices.push(obj.normals[(vn - 1) * 3 + 1]);
        vertices.push(obj.normals[(vn - 1) * 3 + 2]);

        vertices.push(obj.texcoords[(vt - 1) * 2 + 0]);
        vertices.push(obj.texcoords[(vt - 1) * 2 + 1]);
      }
    }

    this.vbuf = device.createBuffer({
      size: vertices.length * SIZE_FLOAT,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this.vbuf,
      0,
      new Float32Array(vertices),
      0,
      vertices.length,
    );

    if (indices.length % 4 !== 0) {
      console.warn("model indices aren't a multiple of 4");
      while (indices.length % 4 !== 0) {
        indices.push(0);
      }
    }

    this.ibuf = device.createBuffer({
      size: indices.length * SIZE_UINT16,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this.ibuf,
      0,
      new Uint16Array(indices),
      0,
      indices.length,
    );

    this.indexCount = indices.length;
  }

  static async load(file: string) {
    const obj = await OBJLoader.load(file);
    return new Model(obj);
  }

  public draw(pass: GPURenderPassEncoder, instanceCount?: number) {
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, "uint16");
    pass.drawIndexed(this.indexCount, instanceCount);
  }
}

class Stats {
  private beginTime = 0;
  private prevTime = 0;
  private textY = 0;
  private canvasWidth = 0;
  private context2D: CanvasRenderingContext2D;

  private static FONT_SIZE = 13;

  constructor(private canvas: HTMLCanvasElement) {
    this.context2D = canvas.getContext("2d")!;
  }

  public beginFrame(time: number) {
    this.prevTime = this.beginTime;
    this.beginTime = time;
  }

  public endFrame() {
    const width = Math.round(this.canvasWidth) + 8;
    const height = this.textY + 8;
    if (width !== this.canvas.width || height !== this.canvas.height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.canvasWidth = 100;
    this.textY = 0;

    this.context2D.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.context2D.globalAlpha = 0.5;
    this.context2D.fillStyle = "white";
    this.context2D.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.context2D.globalAlpha = 1;

    this.context2D.fillStyle = "black";
    this.context2D.font = `bold ${Stats.FONT_SIZE}px monospace`;

    const frameDelta = this.beginTime - this.prevTime;
    const fps = (1 / frameDelta) * 1000;
    this.draw(`ms/frame: ${frameDelta.toFixed(2)}ms (${Math.round(fps)}fps)`);

    const updateDelta = performance.now() - this.beginTime;
    const cpuFPS = (1 / updateDelta) * 1000;
    this.draw(`cpu: ${updateDelta.toFixed(2)}ms (${Math.round(cpuFPS)}fps)`);

    if (instrument !== undefined) {
      const gpuDelta = instrument.avg / 1000 / 1000;
      const gpuFPS = (1 / gpuDelta) * 1000;
      this.draw(`gpu: ${gpuDelta.toFixed(2)}ms (${Math.round(gpuFPS)}fps)`);
    }

    let mem = 0;
    const { memory } = performance as any;
    if (memory !== undefined) {
      mem = memory.usedJSHeapSize / 1024 / 1024;
    }

    if (mem !== 0) {
      this.draw(`mem: ${mem.toFixed(2)}mb`);
    }
  }

  private draw(text: string) {
    const left = 5;
    this.textY += Stats.FONT_SIZE;
    this.context2D.fillText(text, left, this.textY);

    this.canvasWidth = Math.max(
      this.canvasWidth,
      this.context2D.measureText(text).width + left,
    );
  }
}

class Instrument {
  private index = 0;
  private querySet: GPUQuerySet;
  private resolve: GPUBuffer;
  private result: GPUBuffer;
  public avg = 0;

  private static MAX_QUERIES = 64;

  constructor() {
    this.querySet = device.createQuerySet({
      type: "timestamp",
      count: 2 * Instrument.MAX_QUERIES,
    });

    this.resolve = device.createBuffer({
      size: this.querySet.count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });

    this.result = device.createBuffer({
      size: this.querySet.count * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  public record() {
    console.assert(this.index < Instrument.MAX_QUERIES);

    const timestampWrites: GPURenderPassTimestampWrites = {
      querySet: this.querySet,
      beginningOfPassWriteIndex: this.index,
      endOfPassWriteIndex: this.index + 1,
    };

    this.index += 2;
    return timestampWrites;
  }

  public endFrame(command: GPUCommandEncoder) {
    if (this.result.mapState !== "unmapped") {
      return;
    }

    command.resolveQuerySet(
      this.querySet,
      0,
      this.querySet.count,
      this.resolve,
      0,
    );
    command.copyBufferToBuffer(
      this.resolve,
      0,
      this.result,
      0,
      this.result.size,
    );
  }

  public async measure() {
    if (this.result.mapState !== "unmapped") {
      return;
    }

    await this.result.mapAsync(GPUMapMode.READ);

    let total = 0;
    const buf = new BigInt64Array(this.result.getMappedRange());
    for (let i = 0; i < this.index; i += 2) {
      const start = buf[i + 0];
      const end = buf[i + 1];

      total += Number(end - start);
    }

    this.result.unmap();

    let count = this.index / 2;
    this.index = 0;

    if (count > 0) {
      this.avg = total / count;
    }
  }
}

interface CacheEntryBindGroup {
  resource: GPUBindGroup;
  descriptor: GPUBindGroupDescriptor;
  lifetime: number;
}

interface CacheEntrySampler {
  resource: GPUSampler;
  descriptor: GPUSamplerDescriptor;
}

class RenderCache {
  private bindGroupLayouts = new Map<GPURenderPipeline, GPUBindGroupLayout[]>();
  private bindGroups: CacheEntryBindGroup[] = [];
  private samplers: CacheEntrySampler[] = [];

  public step() {
    let i = 0;
    while (i < this.bindGroups.length) {
      this.bindGroups[i].lifetime--;
      if (this.bindGroups[i].lifetime === 0) {
        this.bindGroups[i] = this.bindGroups[this.bindGroups.length - 1];
        this.bindGroups.pop();
      } else {
        i++;
      }
    }
  }

  public getBindGroupLayout(pipeline: GPURenderPipeline, index: number) {
    const arr = this.bindGroupLayouts.get(pipeline);
    if (arr === undefined) {
      const layout = pipeline.getBindGroupLayout(index);
      this.bindGroupLayouts.set(pipeline, [layout]);
      return layout;
    }

    const item = arr[index];
    if (item === undefined) {
      const layout = pipeline.getBindGroupLayout(index);
      arr[index] = layout;
      return layout;
    }

    return item;
  }

  public createBindGroup(descriptor: GPUBindGroupDescriptor) {
    const lifetime = 4;

    for (const bindGroup of this.bindGroups) {
      if (RenderCache.sameBindGroup(bindGroup.descriptor, descriptor)) {
        return bindGroup.resource;
      }
    }

    const bindGroup = device.createBindGroup(descriptor);
    this.bindGroups.push({ resource: bindGroup, descriptor, lifetime });
    return bindGroup;
  }

  private static sameBindGroup(
    lhs: GPUBindGroupDescriptor,
    rhs: GPUBindGroupDescriptor,
  ) {
    console.assert(lhs.layout === rhs.layout);

    const left = lhs.entries as GPUBindGroupEntry[];
    const right = rhs.entries as GPUBindGroupEntry[];

    if (left.length !== right.length) {
      return false;
    }

    for (let i = 0; i < left.length; i++) {
      if (!RenderCache.sameBindGroupEntry(left[i], right[i])) {
        return false;
      }
    }

    return true;
  }

  private static sameBindGroupEntry(
    lhs: GPUBindGroupEntry,
    rhs: GPUBindGroupEntry,
  ) {
    if (lhs.binding !== rhs.binding) {
      return false;
    }

    if (lhs.resource !== rhs.resource) {
      if (
        !lhs.resource.hasOwnProperty("buffer") ||
        !rhs.resource.hasOwnProperty("buffer")
      ) {
        return false;
      }

      const l = lhs.resource as GPUBufferBinding;
      const r = rhs.resource as GPUBufferBinding;

      if (l.buffer !== r.buffer || l.offset !== r.offset || l.size !== r.size) {
        return false;
      }
    }

    return true;
  }

  public createSampler(descriptor: GPUSamplerDescriptor) {
    for (const item of this.samplers) {
      if (RenderCache.sameSampler(item.descriptor, descriptor)) {
        return item.resource;
      }
    }

    const sampler = device.createSampler(descriptor);
    this.samplers.push({ resource: sampler, descriptor });
    return sampler;
  }

  private static sameSampler(
    lhs: GPUSamplerDescriptor,
    rhs: GPUSamplerDescriptor,
  ) {
    return (
      lhs.addressModeU === rhs.addressModeU &&
      lhs.addressModeV === rhs.addressModeV &&
      lhs.addressModeW === rhs.addressModeW &&
      lhs.magFilter === rhs.magFilter &&
      lhs.minFilter === rhs.minFilter &&
      lhs.mipmapFilter === rhs.mipmapFilter &&
      lhs.lodMinClamp === rhs.lodMinClamp &&
      lhs.lodMaxClamp === rhs.lodMaxClamp &&
      lhs.compare === rhs.compare &&
      lhs.maxAnisotropy === rhs.maxAnisotropy
    );
  }
}

class Sky {
  private pipeline: GPURenderPipeline;

  constructor() {
    const shader = device.createShaderModule({ code: uniformsWGSL + skyWGSL });

    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
      },
      depthStencil: {
        format: "depth24plus",
        depthCompare: "less-equal",
        depthWriteEnabled: true,
      },
      vertex: {
        module: shader,
        entryPoint: "vp",
      },
      fragment: {
        module: shader,
        entryPoint: "fp",
        targets: [{ format: presentationFormat }],
      },
    });
  }

  public run(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    pass.draw(3);
  }
}

class Shell {
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;

  private static SHELL_COUNT = 64;

  constructor() {
    const shader = device.createShaderModule({
      code: uniformsWGSL + shellWGSL,
    });

    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      primitive: {
        topology: "triangle-list",
      },
      depthStencil: {
        format: "depth24plus",
        depthCompare: "less",
        depthWriteEnabled: true,
      },
      vertex: {
        entryPoint: "vp",
        module: shader,
        buffers: [
          {
            stepMode: "vertex",
            arrayStride: (3 + 3 + 2) * SIZE_FLOAT,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 0, format: "float32x3" },
              { shaderLocation: 2, offset: 0, format: "float32x2" },
            ],
          },
        ],
        constants: {
          SHELL_COUNT: Shell.SHELL_COUNT,
        },
      },
      fragment: {
        entryPoint: "fp",
        module: shader,
        targets: [
          {
            format: presentationFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              alpha: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
            },
          },
        ],
        constants: {
          SHELL_COUNT: Shell.SHELL_COUNT,
        },
      },
    });

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }],
    });
  }

  public run(pass: GPURenderPassEncoder, model?: Model) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    model?.draw(pass, Shell.SHELL_COUNT);
  }
}

class FXAA {
  private pipeline: GPURenderPipeline;

  constructor() {
    const shader = device.createShaderModule({ code: uniformsWGSL + fxaaWGSL });

    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      primitive: {
        topology: "triangle-list",
        cullMode: "back",
      },
      vertex: {
        module: shader,
        entryPoint: "vp",
      },
      fragment: {
        module: shader,
        entryPoint: "fp",
        targets: [{ format: presentationFormat }],
      },
    });
  }

  public run(pass: GPURenderPassEncoder, inView: GPUTextureView) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(
      0,
      cache.createBindGroup({
        layout: cache.getBindGroupLayout(this.pipeline, 0),
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: inView },
          {
            binding: 2,
            resource: cache.createSampler({
              minFilter: "linear",
              magFilter: "linear",
            }),
          },
        ],
      }),
    );
    pass.draw(3);
  }
}

async function main() {
  let adapter: GPUAdapter;
  let canvas: HTMLCanvasElement;
  let context: GPUCanvasContext;

  try {
    const request = await navigator.gpu.requestAdapter();
    if (request === null) {
      throw "no adapter";
    }
    adapter = request;

    device = await adapter.requestDevice({
      requiredFeatures: ["timestamp-query"],
    });

    canvas = document.getElementById("canvas") as HTMLCanvasElement;
    context = canvas.getContext("webgpu")!;
    if (context === null) {
      throw "no context";
    }
  } catch (e) {
    alert("Your browser doesn't support WebGPU");
    return;
  }

  presentationFormat = navigator.gpu.getPreferredCanvasFormat();

  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  addEventListener("resize", () => {
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
  });

  mouse.prevX = canvas.width / 2;
  mouse.prevY = canvas.height / 2;
  mouse.x = mouse.prevX;
  mouse.y = mouse.prevY;

  context.configure({
    device,
    format: presentationFormat,
    alphaMode: "premultiplied",
  });

  const stats = new Stats(
    document.getElementById("stats") as HTMLCanvasElement,
  );

  if (
    adapter.features.has("timestamp-query") &&
    typeof device.createQuerySet === "function"
  ) {
    instrument = new Instrument();
  }

  const uniformBuffer = new ArrayBuffer(SIZE_MAT4 + SIZE_MAT4 + SIZE_VEC4);
  const u = {
    cameraView: new Float32Array(uniformBuffer, 0, 16),
    cameraProjection: new Float32Array(uniformBuffer, 16 * SIZE_FLOAT, 16),
    screenResolution: new Float32Array(uniformBuffer, 32 * SIZE_FLOAT, 4),
  };

  uniformsWGSL = `
struct Uniforms {
  cameraView: mat4x4f,
  cameraProjection: mat4x4f,
  screenResolution: vec2f,
}
`;

  ubuf = device.createBuffer({
    size: uniformBuffer.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache = new RenderCache();

  const shell = new Shell();
  const sky = new Sky();
  const fxaa = new FXAA();

  const camera = new Camera(vec3.create(0, 0, 3), -90 * RADIANS);

  let model: Model | undefined;
  Model.load("data/sphere.obj").then((m) => (model = m));

  let renderTarget: GPUTexture;
  let renderTargetView: GPUTextureView;
  let depthBuffer: GPUTexture;
  let depthBufferView: GPUTextureView;
  let renderWidth = 0;
  let renderHeight = 0;

  function update(time: number) {
    stats.beginFrame(time);

    const { width, height } = canvas;

    camera.update();

    mouse.deltaX = mouse.x - mouse.prevX;
    mouse.deltaY = mouse.y - mouse.prevY;
    mouse.prevX = mouse.x;
    mouse.prevY = mouse.y;
    mouse.wheel = 0;

    camera.view(u.cameraView);
    mat4.perspective(60 * RADIANS, width / height, 0.1, 50, u.cameraProjection);

    vec2.set(width, height, u.screenResolution);

    device.queue.writeBuffer(
      ubuf,
      0,
      uniformBuffer,
      0,
      uniformBuffer.byteLength,
    );

    if (renderWidth !== width && renderHeight !== height) {
      renderWidth = width;
      renderHeight = height;

      renderTarget?.destroy();
      depthBuffer?.destroy();

      renderTarget = device.createTexture({
        size: [width, height, 1],
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        format: presentationFormat,
      });
      renderTargetView = renderTarget.createView();

      depthBuffer = device.createTexture({
        size: [width, height, 1],
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        format: "depth24plus",
      });
      depthBufferView = depthBuffer.createView();
    }

    const command = device.createCommandEncoder();
    const surfaceView = context.getCurrentTexture().createView();

    {
      const pass = command.beginRenderPass({
        label: "forward rendering pass",
        timestampWrites: instrument?.record(),
        colorAttachments: [
          {
            view: renderTargetView,
            clearValue: [0.7, 0.8, 0.9, 1],
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depthBufferView,
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthReadOnly: false,
        },
      });

      sky.run(pass);
      shell.run(pass, model);

      pass.end();
    }

    {
      const pass = command.beginRenderPass({
        label: "fxaa pass",
        timestampWrites: instrument?.record(),
        colorAttachments: [
          {
            view: surfaceView,
            clearValue: [0, 0, 0, 1],
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      fxaa.run(pass, renderTargetView);
      pass.end();
    }

    instrument?.endFrame(command);
    device.queue.submit([command.finish()]);

    instrument?.measure();
    stats.endFrame();
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

main();
