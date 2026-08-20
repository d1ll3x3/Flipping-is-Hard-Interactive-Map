using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace FIHMapExport
{
    /// <summary>
    /// Walks the live level and writes where everything is. See SceneDump for why the
    /// geometry is not part of this.
    /// </summary>
    internal static class SceneDumper
    {
        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            WriteIndented = true
        };

        public static void Run(Scene scene)
        {
            var dump = Collect(scene);

            string file = Path.Combine(ExportPlugin.OutputDir.Value, "scene.json");
            Directory.CreateDirectory(ExportPlugin.OutputDir.Value);
            Archive(file);
            File.WriteAllText(file, JsonSerializer.Serialize(dump, Options));

            var stats = dump.Stats;
            ExportPlugin.Logger.LogInfo(
                $"Dumped {stats.Nodes} nodes, {dump.Meshes.Count} meshes, {dump.Materials.Count} materials " +
                $"({stats.StreamedOut} streamed out, {stats.RendererOff} renderer-off; "
                + $"skipped {stats.SkippedLod} LOD, {stats.SkippedNoMesh} mesh-less) -> {file}");
        }

        /// <summary>
        /// Moves the previous dump aside instead of losing it.
        ///
        /// A dump is a snapshot of what was loaded, and the NPCs load as the player comes
        /// near, so no single one holds them all - you take one per corner of the level and
        /// merge them offline (tools/merge-dumps.mjs). Overwriting would mean the last press
        /// silently threw away the four before it.
        /// </summary>
        private static void Archive(string file)
        {
            if (!File.Exists(file)) return;

            string folder = Path.Combine(Path.GetDirectoryName(file), "dumps");
            Directory.CreateDirectory(folder);

            string stamp = File.GetLastWriteTime(file).ToString("yyyyMMdd-HHmmss");
            string previous = Path.Combine(folder, $"scene-{stamp}.json");
            if (File.Exists(previous)) File.Delete(previous);

            File.Move(file, previous);
            ExportPlugin.Logger.LogInfo($"Previous dump kept as {previous}");
        }

        private static SceneDump Collect(Scene scene)
        {
            var dump = new SceneDump
            {
                Scene = scene.name,
                ExportedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                LodLevel = ExportPlugin.LodLevel.Value
            };

            // Index maps: the dump references meshes and materials by position, so every
            // asset is described once no matter how many times the level instances it.
            var meshIds = new Dictionary<int, int>();
            var materialIds = new Dictionary<int, int>();
            var demoted = CollectDemotedLodRenderers(scene, dump.Stats);

            foreach (var root in scene.GetRootGameObjects())
            {
                if (root == null) continue;
                AddRenderers(dump, root, demoted, meshIds, materialIds);
            }

            dump.Stats.Nodes = dump.Nodes.Count;
            foreach (var node in dump.Nodes)
            {
                if (!node.ObjectActive) dump.Stats.StreamedOut++;
                if (!node.RendererEnabled) dump.Stats.RendererOff++;
            }

            return dump;
        }

        /// <summary>
        /// A dump of nothing but the given objects and what they draw.
        ///
        /// Same node shape as a full dump, so tools/merge-dumps.mjs folds one into the other
        /// without knowing where it came from. Nothing is demoted for LOD here: the point of
        /// this file is to find out what an NPC actually draws, and filtering on the way out
        /// is how five of them came to be missing from the level dump in the first place.
        /// The offline merge picks the LOD, where the choice can be changed without another
        /// trip through the game.
        /// </summary>
        public static SceneDump Subtrees(string scene, List<GameObject> roots)
        {
            var dump = new SceneDump
            {
                Scene = scene,
                ExportedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                LodLevel = ExportPlugin.LodLevel.Value
            };

            var meshIds = new Dictionary<int, int>();
            var materialIds = new Dictionary<int, int>();
            var nothingDemoted = new HashSet<int>();

            foreach (var root in roots)
            {
                if (root == null) continue;
                AddRenderers(dump, root, nothingDemoted, meshIds, materialIds);
            }

            dump.Stats.Nodes = dump.Nodes.Count;
            return dump;
        }

        /// <summary>Every renderer under one object, as nodes on the dump.</summary>
        private static void AddRenderers(
            SceneDump dump,
            GameObject root,
            HashSet<int> demoted,
            Dictionary<int, int> meshIds,
            Dictionary<int, int> materialIds)
        {
            foreach (var renderer in root.GetComponentsInChildren<Renderer>(true))
            {
                if (renderer == null) continue;
                dump.Stats.Renderers++;

                if (demoted.Contains(renderer.GetInstanceID())) continue;

                var mesh = MeshOf(renderer, out bool skinned);
                if (mesh == null)
                {
                    // Particles, trails and lines have no shareable mesh. They are
                    // effects, not level geometry, so the web map does without them.
                    dump.Stats.SkippedNoMesh++;
                    continue;
                }

                var transform = renderer.transform;
                dump.Nodes.Add(new NodeDump
                {
                    Path = HierarchyPath.Of(transform),
                    Name = transform.name,
                    Mesh = MeshIndex(mesh, dump, meshIds),
                    Materials = MaterialIndices(renderer, dump, materialIds),
                    Pos = Vec(transform.position),
                    Rot = Quat(transform.rotation),
                    Scale = Vec(transform.lossyScale),
                    ObjectActive = renderer.gameObject.activeInHierarchy,
                    RendererEnabled = renderer.enabled,
                    WorldBoundsCenter = Vec(renderer.bounds.center),
                    WorldBoundsSize = Vec(renderer.bounds.size),
                    Skinned = skinned,
                    Layer = renderer.gameObject.layer,
                    LayerName = LayerMask.LayerToName(renderer.gameObject.layer)
                });
            }
        }

        /// <summary>
        /// Renderers belonging to a LOD level we are not keeping. The level ships every
        /// LOD of an object as its own renderer, so without this the export would carry
        /// the same rock three times over.
        /// </summary>
        private static HashSet<int> CollectDemotedLodRenderers(Scene scene, DumpStats stats)
        {
            var demoted = new HashSet<int>();
            int wanted = ExportPlugin.LodLevel.Value;

            foreach (var root in scene.GetRootGameObjects())
            {
                if (root == null) continue;

                foreach (var group in root.GetComponentsInChildren<LODGroup>(true))
                {
                    if (group == null) continue;

                    var levels = group.GetLODs();
                    if (levels == null || levels.Count == 0) continue;

                    // Clamp: not every group has as many levels as the config asks for.
                    int keep = Mathf.Clamp(wanted, 0, levels.Count - 1);

                    for (int i = 0; i < levels.Count; i++)
                    {
                        if (i == keep) continue;
                        foreach (var renderer in levels[i].renderers)
                        {
                            if (renderer == null) continue;
                            if (demoted.Add(renderer.GetInstanceID())) stats.SkippedLod++;
                        }
                    }
                }
            }

            return demoted;
        }

        private static Mesh MeshOf(Renderer renderer, out bool skinned)
        {
            skinned = false;

            var skinnedRenderer = renderer.TryCast<SkinnedMeshRenderer>();
            if (skinnedRenderer != null)
            {
                skinned = true;
                return skinnedRenderer.sharedMesh;
            }

            var filter = renderer.GetComponent<MeshFilter>();
            return filter != null ? filter.sharedMesh : null;
        }

        private static int MeshIndex(Mesh mesh, SceneDump dump, Dictionary<int, int> ids)
        {
            int instanceId = mesh.GetInstanceID();
            if (ids.TryGetValue(instanceId, out int existing)) return existing;

            int id = dump.Meshes.Count;
            var bounds = mesh.bounds;

            dump.Meshes.Add(new MeshRef
            {
                Id = id,
                Name = mesh.name,
                SubMeshCount = mesh.subMeshCount,
                VertexCount = mesh.vertexCount,
                BoundsCenter = Vec(bounds.center),
                BoundsSize = Vec(bounds.size),
                Readable = SafeReadable(mesh)
            });

            ids[instanceId] = id;
            return id;
        }

        private static int[] MaterialIndices(Renderer renderer, SceneDump dump, Dictionary<int, int> ids)
        {
            var materials = renderer.sharedMaterials;
            var indices = new List<int>();

            foreach (var material in materials)
            {
                if (material == null) continue;

                int instanceId = material.GetInstanceID();
                if (ids.TryGetValue(instanceId, out int existing))
                {
                    indices.Add(existing);
                    continue;
                }

                int id = dump.Materials.Count;
                dump.Materials.Add(Describe(material, id));
                ids[instanceId] = id;
                indices.Add(id);
            }

            return indices.ToArray();
        }

        private static MaterialRef Describe(Material material, int id)
        {
            var reference = new MaterialRef
            {
                Id = id,
                Name = material.name,
                Shader = material.shader != null ? material.shader.name : null
            };

            var shader = material.shader;
            if (shader == null) return reference;

            // Walk what the shader declares instead of guessing property names. See
            // MaterialRef for why.
            for (int i = 0; i < shader.GetPropertyCount(); i++)
            {
                string property = shader.GetPropertyName(i);

                try
                {
                    switch (shader.GetPropertyType(i))
                    {
                        case ShaderPropertyType.Texture:
                            var texture = material.GetTexture(property);
                            if (texture == null) continue;
                            reference.Textures[property] = texture.name;
                            reference.TextureSizes[property] = new[] { texture.width, texture.height };
                            break;

                        case ShaderPropertyType.Color:
                            var color = material.GetColor(property);
                            reference.Colors[property] = new[] { color.r, color.g, color.b, color.a };
                            break;
                    }
                }
                catch (Exception ex)
                {
                    ExportPlugin.Logger.LogWarning(
                        $"Material '{material.name}': reading '{property}' failed: {ex.Message}");
                }
            }

            return reference;
        }

        private static bool SafeReadable(Mesh mesh)
        {
            try { return mesh.isReadable; }
            catch { return false; }
        }

        private static float[] Vec(Vector3 v) => new[] { v.x, v.y, v.z };

        private static float[] Quat(Quaternion q) => new[] { q.x, q.y, q.z, q.w };
    }
}
