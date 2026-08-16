// Picks which of a material's many texture and colour properties is the albedo.
//
// The dump carries every property the shader declares, because the mod cannot know which
// one matters and re-running the game to find out is expensive. Choosing happens here,
// where it is cheap to change and re-run.

/** Exact property names, most specific first. Covers URP, the legacy shaders and HDRP. */
const PREFERRED_TEXTURES = [
  '_BaseMap',
  '_MainTex',
  '_BaseColorMap',
  '_AlbedoMap',
  '_Albedo',
  '_DiffuseMap',
  '_Diffuse',
  '_BaseTexture',
  '_ColorMap',
  '_LayerAlbedo',
];

/** Never albedo, whatever they are called: they encode surface data, not colour. */
const NOT_ALBEDO =
  /normal|bump|height|displace|mask|msao|metallic|smoothness|roughness|occlusion|_ao\b|emissi|specular|detail|lightmap|noise|gradient|ramp|flow|distort|dissolve|matcap|cubemap|_lut/i;

/** Names that read as base colour when there is no exact match. */
const LOOKS_ALBEDO = /base|albedo|diffuse|main|color|colour|texture|tex$/i;

export function pickAlbedoTexture(material) {
  const textures = material.Textures ?? {};

  // SG_Standard_MSAO multiplies a greyscale detail map (_MainTex) by a colour looked up in
  // a palette atlas through UV1. glTF has one base colour texture, so the palette wins:
  // _MainTex alone averages near-white and bleached the whole level. The cost is losing
  // the corrugation and grain of the detail map - flat colour where the game has texture.
  if (textures._UV1ColorMapTexture) {
    return { property: '_UV1ColorMapTexture', texture: textures._UV1ColorMapTexture, texCoord: 1 };
  }

  for (const name of PREFERRED_TEXTURES) {
    if (textures[name]) return { property: name, texture: textures[name], texCoord: 0 };
  }

  const candidates = Object.entries(textures).filter(([property]) => !NOT_ALBEDO.test(property));

  const named = candidates.find(([property]) => LOOKS_ALBEDO.test(property));
  if (named) return { property: named[0], texture: named[1], texCoord: 0 };

  // A shader with exactly one usable texture: it can only be the albedo.
  if (candidates.length === 1) {
    return { property: candidates[0][0], texture: candidates[0][1], texCoord: 0 };
  }

  return null;
}

/**
 * The palette atlas of an SG_Standard_MSAO material, or null when it has none.
 *
 * These shaders multiply a greyscale detail map (_MainTex - T_Global_LightWood_A averages
 * 238,238,237, near white) by a colour looked up in a palette atlas through UV1. Using
 * only _MainTex bleached the level; using only the palette gave flat colour with no
 * corrugation or grain. build-glb.mjs bakes the palette lookup into vertex colours, which
 * glTF multiplies over the detail texture - the same product the game computes.
 */
export function pickPaletteTexture(material) {
  return material.Textures?._UV1ColorMapTexture ?? null;
}

/**
 * The second layer of an EHS/SG_StandardLayer material, or null when there is none.
 *
 * These materials blend two surfaces: _LayerAlbedo is the base rock, _DetailAlbedo is what
 * covers it (grass on the ground blocks, mud on the wet ones). glTF only has one base
 * colour texture, so the blend is baked into vertex colours instead - see build-glb.mjs.
 * When both properties point at the same texture the material is effectively single
 * layered and there is nothing to blend.
 */
export function pickDetailTexture(material) {
  const textures = material.Textures ?? {};
  const detail = textures._DetailAlbedo;

  return detail && detail !== textures._LayerAlbedo ? detail : null;
}

const PREFERRED_COLORS = ['_BaseColor', '_Color', '_MainColor', '_TintColor', '_Tint'];

const NOT_BASE_COLOR = /emissi|specular|rim|outline|fog|shadow|highlight|fresnel|subsurface/i;

export function pickBaseColor(material) {
  const colors = material.Colors ?? {};

  for (const name of PREFERRED_COLORS) {
    if (colors[name]) return colors[name];
  }

  const fallback = Object.entries(colors).find(([property]) => !NOT_BASE_COLOR.test(property));
  return fallback ? fallback[1] : null;
}
