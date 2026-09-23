/**
 * 工作流图构建器。
 *
 * 这里产出的是 ComfyUI 的 API 格式（class_type + inputs），直接 POST 给 /prompt。
 * 图的结构严格对齐 E:\ComfyUI\user\default\workflows 里已验证可用的那几个工作流，
 * 只是把提示词、尺寸、种子这些改成由界面传入。
 *
 * 节点输入名全部按 ComfyUI 源码里的 INPUT_TYPES 核对过，改名前先看源码。
 */

export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

// ---------------------------------------------------------------- 模型文件

const M = {
  qwenUnet: "qwen_image_2.1_int8_convrot.safetensors",
  qwenClip: "qwen3vl_8b_int8_convrot.safetensors",
  qwenVae: "qwen_image_2.1_vae_bf16.safetensors",
  zUnet: "z_image_turbo_int8_convrot.safetensors",
  zClip: "qwen_3_4b_fp8_mixed.safetensors",
  zVae: "ae.safetensors",
  esrgan: "RealESRGAN_x4.pth",
} as const;

/** Qwen 2.1 官方推荐参数 */
export const QWEN_DEFAULTS = { steps: 25, cfg: 1.0, sampler: "euler", scheduler: "simple" };
/** Z-Image Turbo 官方推荐参数 */
export const ZIMAGE_DEFAULTS = { steps: 8, cfg: 1.0, sampler: "res_multistep", scheduler: "simple", shift: 3 };
/** 2K 放大后的精修参数（来自已验证的 Z-Image2K放大 工作流） */
export const UPSCALE_DEFAULTS = {
  steps: 5,
  cfg: 1.0,
  sampler: "dpmpp_2m_sde",
  scheduler: "beta",
  denoise: 0.33,
  scaleBy: 0.5, // ESRGAN 放大 4 倍后再缩到 0.5，净得 2 倍
};

// ---------------------------------------------------------------- 公共片段

/** Qwen 2.1 的三件套加载器 */
function qwenLoaders(unet: string, clip: string, vae: string) {
  return {
    [unet]: { class_type: "UNETLoader", inputs: { unet_name: M.qwenUnet, weight_dtype: "default" } },
    [clip]: {
      class_type: "CLIPLoader",
      inputs: { clip_name: M.qwenClip, type: "qwen_image", device: "default" },
    },
    [vae]: { class_type: "VAELoader", inputs: { vae_name: M.qwenVae } },
  };
}

/** Z-Image 的三件套加载器 */
function zLoaders(unet: string, clip: string, vae: string) {
  return {
    [unet]: { class_type: "UNETLoader", inputs: { unet_name: M.zUnet, weight_dtype: "default" } },
    [clip]: {
      class_type: "CLIPLoader",
      inputs: { clip_name: M.zClip, type: "lumina2", device: "default" },
    },
    [vae]: { class_type: "VAELoader", inputs: { vae_name: M.zVae } },
  };
}

/** 把若干张已上传的参考图挂到 TextEncodeQwenImage21 的 autogrow 输入上 */
function refImageInputs(refs: string[], startNodeId: number) {
  const inputs: Record<string, unknown> = {};
  const nodes: Graph = {};
  refs.forEach((name, i) => {
    const id = String(startNodeId + i);
    nodes[id] = { class_type: "LoadImage", inputs: { image: name } };
    // autogrow 的输入名是「组名.模板名」，1 起数，写错 ComfyUI 会直接报参数校验失败
    inputs[`images.image_${i + 1}`] = [id, 0];
  });
  return { inputs, nodes, nextId: startNodeId + refs.length };
}

/**
 * Z-Image 的 2K 放大精修链，接在任意 IMAGE 输出后面。
 * 结构：ESRGAN 4x → lanczos 缩到 2x → VAE 编码 → 低降噪重采样 → 解码
 */
function upscaleChain(
  srcImage: [string, number],
  base: number,
  opts: UpscaleOpts,
): { nodes: Graph; lastId: string } {
  const n = (i: number) => String(base + i);
  const nodes: Graph = {
    [n(0)]: { class_type: "SplitImageWithAlpha", inputs: { image: srcImage } },
    [n(1)]: { class_type: "UpscaleModelLoader", inputs: { model_name: M.esrgan } },
    [n(2)]: {
      class_type: "ImageUpscaleWithModel",
      inputs: { upscale_model: [n(1), 0], image: [n(0), 0] },
    },
    [n(3)]: {
      class_type: "ImageScaleBy",
      inputs: { image: [n(2), 0], upscale_method: "lanczos", scale_by: opts.scaleBy },
    },
    [n(4)]: { class_type: "VAELoader", inputs: { vae_name: M.zVae } },
    [n(5)]: { class_type: "VAEEncode", inputs: { pixels: [n(3), 0], vae: [n(4), 0] } },
    [n(6)]: { class_type: "UNETLoader", inputs: { unet_name: M.zUnet, weight_dtype: "default" } },
    [n(7)]: {
      class_type: "CLIPLoader",
      inputs: { clip_name: M.zClip, type: "lumina2", device: "default" },
    },
    [n(8)]: {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: [n(6), 0], shift: ZIMAGE_DEFAULTS.shift },
    },
    [n(9)]: { class_type: "CLIPTextEncode", inputs: { clip: [n(7), 0], text: opts.prompt } },
    [n(10)]: { class_type: "CLIPTextEncode", inputs: { clip: [n(7), 0], text: "" } },
    [n(11)]: {
      class_type: "KSampler",
      inputs: {
        model: [n(8), 0],
        positive: [n(9), 0],
        negative: [n(10), 0],
        latent_image: [n(5), 0],
        seed: opts.seed,
        steps: opts.steps,
        cfg: opts.cfg,
        sampler_name: opts.sampler,
        scheduler: opts.scheduler,
        denoise: opts.denoise,
      },
    },
    [n(12)]: { class_type: "VAEDecode", inputs: { samples: [n(11), 0], vae: [n(4), 0] } },
  };
  return { nodes, lastId: n(12) };
}

export interface UpscaleOpts {
  prompt: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  scaleBy: number;
}

// ---------------------------------------------------------------- 各模式

export interface CommonOpts {
  prompt: string;
  negative: string;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  filenamePrefix: string;
}

/** 文生图。Qwen 2.1 走 TextEncode 的 latent 是空的，所以用 EmptyLatentImage 定尺寸。 */
export function buildTxt2Img(
  o: CommonOpts & { model: "qwen" | "zimage"; width: number; height: number },
): Graph {
  const g: Graph = {};

  if (o.model === "zimage") {
    Object.assign(g, zLoaders("1", "2", "3"));
    g["4"] = {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["1", 0], shift: ZIMAGE_DEFAULTS.shift },
    };
    g["5"] = { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: o.prompt } };
    // Z-Image 的 CFG 固定为 1，负向不参与运算，但仍要走 ConditioningZeroOut 保持图结构一致
    g["6"] = { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: o.negative } };
    g["7"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } };
    g["8"] = {
      class_type: "EmptySD3LatentImage",
      inputs: { width: o.width, height: o.height, batch_size: 1 },
    };
    g["9"] = {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0],
        positive: ["5", 0],
        negative: ["7", 0],
        latent_image: ["8", 0],
        seed: o.seed,
        steps: o.steps,
        cfg: ZIMAGE_DEFAULTS.cfg,
        sampler_name: o.sampler,
        scheduler: o.scheduler,
        denoise: 1.0,
      },
    };
    g["10"] = { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } };
    g["11"] = {
      class_type: "SaveImage",
      inputs: { images: ["10", 0], filename_prefix: o.filenamePrefix },
    };
    return g;
  }

  Object.assign(g, qwenLoaders("1", "2", "3"));
  g["4"] = {
    class_type: "TextEncodeQwenImage21",
    inputs: {
      clip: ["2", 0],
      prompt: o.prompt,
      negative_prompt: o.negative,
      resolution: 1024,
    },
  };
  g["5"] = {
    class_type: "EmptyLatentImage",
    inputs: { width: o.width, height: o.height, batch_size: 1 },
  };
  g["6"] = {
    class_type: "KSampler",
    inputs: {
      model: ["1", 0],
      positive: ["4", 0],
      negative: ["4", 1],
      latent_image: ["5", 0],
      seed: o.seed,
      steps: o.steps,
      cfg: o.cfg,
      sampler_name: o.sampler,
      scheduler: o.scheduler,
      denoise: 1.0,
    },
  };
  g["7"] = { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } };
  g["8"] = { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: o.filenamePrefix } };
  return g;
}

/**
 * 单图编辑 / 多参考图。
 *
 * 关键点：输出尺寸不来自 EmptyLatentImage，而是 TextEncodeQwenImage21 的第三个输出
 * —— 它按第一张参考图的宽高比生成空 latent。接错会让出图比例跟原图对不上。
 */
export function buildEdit(
  o: CommonOpts & { refs: string[]; resolution: number; cache?: boolean; upscale?: UpscaleOpts },
): Graph {
  if (o.refs.length === 0) throw new Error("至少需要一张参考图");

  const g: Graph = {};
  Object.assign(g, qwenLoaders("1", "3", "4"));

  // 多图时 KV 缓存能显著省显存，单图没必要
  const modelNode = o.cache ? "2" : "1";
  if (o.cache) {
    g["2"] = {
      class_type: "QwenImage21Cache",
      inputs: { model: ["1", 0], device: "auto", dtype: "default" },
    };
  }

  const refs = refImageInputs(o.refs, 10);
  Object.assign(g, refs.nodes);

  const encId = String(refs.nextId);
  g[encId] = {
    class_type: "TextEncodeQwenImage21",
    inputs: {
      clip: ["3", 0],
      prompt: o.prompt,
      negative_prompt: o.negative,
      resolution: o.resolution,
      vae: ["4", 0],
      ...refs.inputs,
    },
  };

  const samplerId = String(refs.nextId + 1);
  g[samplerId] = {
    class_type: "KSampler",
    inputs: {
      model: [modelNode, 0],
      positive: [encId, 0],
      negative: [encId, 1],
      latent_image: [encId, 2],
      seed: o.seed,
      steps: o.steps,
      cfg: o.cfg,
      sampler_name: o.sampler,
      scheduler: o.scheduler,
      denoise: 1.0,
    },
  };

  const decodeId = String(refs.nextId + 2);
  g[decodeId] = { class_type: "VAEDecode", inputs: { samples: [samplerId, 0], vae: ["4", 0] } };

  if (o.upscale) {
    // 接 2K 精修链，落盘的换成精修链的输出
    const chain = upscaleChain([decodeId, 0], refs.nextId + 3, o.upscale);
    Object.assign(g, chain.nodes);
    g[String(refs.nextId + 3 + 13)] = {
      class_type: "SaveImage",
      inputs: { images: [chain.lastId, 0], filename_prefix: o.filenamePrefix },
    };
  } else {
    g[String(refs.nextId + 3)] = {
      class_type: "SaveImage",
      inputs: { images: [decodeId, 0], filename_prefix: o.filenamePrefix },
    };
  }
  return g;
}

/** 独立的 2K 放大：输入任意图，输出约 2 倍尺寸并做一次低降噪重绘。 */
export function buildUpscale(o: {
  input: string;
  filenamePrefix: string;
  upscale: UpscaleOpts;
}): Graph {
  const g: Graph = {
    "1": { class_type: "LoadImage", inputs: { image: o.input } },
  };
  const chain = upscaleChain(["1", 0], 2, o.upscale);
  Object.assign(g, chain.nodes);
  g["15"] = {
    class_type: "SaveImage",
    inputs: { images: [chain.lastId, 0], filename_prefix: o.filenamePrefix },
  };
  return g;
}

// ---------------------------------------------------------------- 模式表

export type ModeId = "txt2img" | "edit" | "multiref" | "multiref2k" | "upscale" | "video";

export interface SlotSpec {
  key: string;
  label: string;
  required: boolean;
}

export interface ModeSpec {
  id: ModeId;
  label: string;
  tagline: string;
  /** 参考图槽位 */
  slots: SlotSpec[];
  /** 尺寸怎么来：free=自己填；followsRef=跟随第一张参考图；none=由放大链决定 */
  size: "free" | "followsRef" | "none";
  /** 是否显示 Qwen / Z-Image 切换 */
  modelSwitch: boolean;
  /** 提示词预填 */
  promptPlaceholder: string;
  promptDefault: string;
  /** 送进 ComfyUI 输出目录的子目录名 */
  outputSubfolder: string;
  /** 界面上给出的提示词写法示范 */
  tips: string[];
}

export const MODES: Record<ModeId, ModeSpec> = {
  video: {
    id: "video", label: "帧生视频", tagline: "让画面动起来 · MiniMax H3 本地生成",
    slots: [{ key: "first", label: "首帧", required: true }, { key: "last", label: "尾帧", required: false }],
    size: "free", modelSwitch: false, promptPlaceholder: "描述主体动作、镜头运动和声音…", promptDefault: "",
    outputSubfolder: "帧生视频", tips: ["首帧决定起点，尾帧可选，用来控制结束画面。", "描述动作如何发生，以及镜头与声音随时间的变化。"],
  },
  txt2img: {
    id: "txt2img",
    label: "文生图",
    tagline: "只写提示词，从零出图",
    slots: [],
    size: "free",
    modelSwitch: true,
    promptPlaceholder: "用完整句子描述画面，越具体越好…",
    promptDefault: "",
    outputSubfolder: "文生图",
    tips: [
      "写完整句子，不要堆关键词 —— Qwen 2.1 是按语义理解提示词的",
      "把主体、动作、环境、光线、画风依次说清楚",
      "示例：一位穿青色旗袍的年轻女子站在雨后的青石巷口，侧身回望，暖黄灯笼映在她脸上，胶片质感",
    ],
  },
  edit: {
    id: "edit",
    label: "单图编辑",
    tagline: "上传一张图，改衣服 / 换背景 / 调风格",
    slots: [{ key: "ref1", label: "原图", required: true }],
    size: "followsRef",
    modelSwitch: false,
    promptPlaceholder: "把她的衣服换成白色旗袍，人物和场景保持不变",
    promptDefault: "",
    outputSubfolder: "单图编辑",
    tips: [
      "公式：改什么 + 改成什么 + 什么保持不变",
      "一定要写「保持…不变」，否则模型会顺手改掉别的地方",
      "输出尺寸自动跟随原图比例，不用手填",
    ],
  },
  multiref: {
    id: "multiref",
    label: "多参考图",
    tagline: "多张图组合：人物 + 服装 + 场景",
    slots: [
      { key: "ref1", label: "参考图 1", required: true },
      { key: "ref2", label: "参考图 2", required: true },
      { key: "ref3", label: "参考图 3", required: false },
      { key: "ref4", label: "参考图 4", required: false },
      { key: "ref5", label: "参考图 5", required: false },
      { key: "ref6", label: "参考图 6", required: false },
    ],
    size: "followsRef",
    modelSwitch: false,
    promptPlaceholder: "保持<image1>中的人物和姿势不变，让她穿上<image2>中的服装",
    promptDefault: "",
    outputSubfolder: "多参考图",
    tips: [
      "用 <image1> <image2> 引用对应位置的参考图",
      "输出尺寸跟随参考图 1 的比例，把它放成你想要的构图",
      "示例：保持<image1>的人物与姿势，穿上<image2>的服装，背景换成<image3>的雪夜街道",
    ],
  },
  multiref2k: {
    id: "multiref2k",
    label: "多参考图 + 2K",
    tagline: "多图组合出图，再自动做 2K 精修放大",
    slots: [
      { key: "ref1", label: "参考图 1", required: true },
      { key: "ref2", label: "参考图 2", required: true },
      { key: "ref3", label: "参考图 3", required: false },
      { key: "ref4", label: "参考图 4", required: false },
      { key: "ref5", label: "参考图 5", required: false },
      { key: "ref6", label: "参考图 6", required: false },
    ],
    size: "followsRef",
    modelSwitch: false,
    promptPlaceholder: "保持<image1>中的人物和姿势不变，让她穿上<image2>中的服装",
    promptDefault: "",
    outputSubfolder: "多参考图+2K",
    tips: [
      "出图后自动接 Z-Image 放大链，尺寸约翻倍",
      "比「先出图再单独放大」省一次手工操作，但耗时也更长",
      "精修的降噪强度在「高级参数」里，调高会更锐利但也更容易走形",
    ],
  },
  upscale: {
    id: "upscale",
    label: "2K 放大",
    tagline: "任意图片放大到 2 倍并补细节",
    slots: [{ key: "input", label: "待放大的图", required: true }],
    size: "none",
    modelSwitch: false,
    promptPlaceholder: "masterpiece, 8k, highly detailed",
    promptDefault: "masterpiece, 8k, highly detailed",
    outputSubfolder: "2K放大",
    tips: [
      "尺寸由放大链决定：先 4 倍再缩到 0.5，净得 2 倍",
      "1024 的图放完约 2048，2048 的图放完约 4096（显存吃紧时建议先降到 1024）",
      "降噪强度 0.33 是保守值，能补细节又不改构图；调到 0.5 以上会明显改变画面",
    ],
  },
};

export const MODE_ORDER: ModeId[] = ["txt2img", "edit", "multiref", "multiref2k", "upscale", "video"];
