using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace FIHMapExport
{
    /// <summary>
    /// Phase 0 of the export: reports what the level's geometry looks like from inside the
    /// game, before any exporter code is written.
    ///
    /// The whole plan hinges on one unknown. If the game's meshes were built without
    /// Read/Write enabled, Mesh.vertices comes back empty at runtime and no amount of mod
    /// code can recover it - the geometry would have to be ripped offline instead. This
    /// answers that, and sizes the resulting .glb while it is at it.
    /// </summary>
    internal static class SceneProbe
    {
        public static void Run(Scene scene)
        {
            var report = new StringBuilder();
            Collect(scene, report);

            string text = report.ToString();
            ExportPlugin.Logger.LogInfo(text);

            string file = Path.Combine(ExportPlugin.OutputDir.Value, "probe.txt");
            try
            {
                Directory.CreateDirectory(ExportPlugin.OutputDir.Value);
                File.WriteAllText(file, text);
                ExportPlugin.Logger.LogInfo($"Probe written to {file}");
            }
            catch (Exception ex)
            {
                // The findings are already in the log, so a write failure is not fatal -
                // but it must not pass silently either.
                ExportPlugin.Logger.LogError($"Could not write {file}: {ex}");
            }
        }

        private static void Collect(Scene scene, StringBuilder report)
        {
            report.AppendLine("=== FIH map export probe ===");
            report.AppendLine($"scene: {scene.name}");
            report.AppendLine($"time:  {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            report.AppendLine();

            int meshFilters = 0, skinned = 0, readable = 0, unreadable = 0;
            long totalVerts = 0, totalTris = 0;
            var seenMeshes = new HashSet<int>();
            var seenMaterials = new HashSet<int>();
            var textures = new Dictionary<int, string>();
            var shaders = new Dictionary<string, int>();
            var sample = new Sample();

            foreach (var root in scene.GetRootGameObjects())
            {
                if (root == null) continue;

                foreach (var filter in root.GetComponentsInChildren<MeshFilter>(true))
                {
                    if (filter == null) continue;
                    meshFilters++;
                    Inspect(filter.sharedMesh, filter.name, seenMeshes,
                        ref readable, ref unreadable, ref totalVerts, ref totalTris, sample);
                }

                // Skinned meshes carry no MeshFilter; without this pass they'd go uncounted.
                foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                {
                    if (smr == null) continue;
                    skinned++;
                    Inspect(smr.sharedMesh, smr.name, seenMeshes,
                        ref readable, ref unreadable, ref totalVerts, ref totalTris, sample);
                }

                foreach (var renderer in root.GetComponentsInChildren<Renderer>(true))
                {
                    if (renderer == null) continue;
                    foreach (var material in renderer.sharedMaterials)
                    {
                        if (material == null) continue;
                        if (!seenMaterials.Add(material.GetInstanceID())) continue;

                        string shader = material.shader != null ? material.shader.name : "(none)";
                        shaders.TryGetValue(shader, out int count);
                        shaders[shader] = count + 1;

                        CollectTexture(material, "_BaseMap", textures);
                        CollectTexture(material, "_MainTex", textures);
                    }
                }
            }

            report.AppendLine($"MeshFilter            {meshFilters}");
            report.AppendLine($"SkinnedMeshRenderer   {skinned}");
            report.AppendLine($"unique meshes         {seenMeshes.Count}");
            report.AppendLine($"  readable            {readable}");
            report.AppendLine($"  NOT readable        {unreadable}");
            report.AppendLine($"unique materials      {seenMaterials.Count}");
            report.AppendLine($"unique textures       {textures.Count}");
            report.AppendLine();
            report.AppendLine($"vertices (unique meshes)  {totalVerts}");
            report.AppendLine($"triangles                 {totalTris}");
            report.AppendLine();
            report.AppendLine($"sample readable mesh: {sample.Line ?? "(none found)"}");
            report.AppendLine();

            report.AppendLine("shaders:");
            foreach (var entry in shaders) report.AppendLine($"  {entry.Value,4}x  {entry.Key}");
            report.AppendLine();

            report.AppendLine("textures:");
            foreach (var entry in textures) report.AppendLine($"  {entry.Value}");
            report.AppendLine();

            report.AppendLine(Verdict(readable, unreadable));
        }

        private static string Verdict(int readable, int unreadable)
        {
            if (readable == 0) return "VERDICT: no readable meshes - geometry has to be ripped offline.";
            if (unreadable == 0) return "VERDICT: meshes are readable - the in-game exporter works.";
            return "VERDICT: mixed - only part of the level can be exported from in-game.";
        }

        /// <summary>Holds the first mesh that actually handed back vertex data.</summary>
        private sealed class Sample
        {
            public string Line;
        }

        private static void Inspect(Mesh mesh, string owner, HashSet<int> seen,
            ref int readable, ref int unreadable, ref long totalVerts, ref long totalTris,
            Sample sample)
        {
            if (mesh == null) return;
            if (!seen.Add(mesh.GetInstanceID())) return;

            bool isReadable;
            try { isReadable = mesh.isReadable; }
            catch { isReadable = false; }

            if (!isReadable)
            {
                unreadable++;
                return;
            }

            readable++;
            totalVerts += mesh.vertexCount;

            try
            {
                // The flag alone is not proof - Unity reports isReadable on empty meshes
                // too. Read the arrays back and report what actually arrived, because that
                // is the data the exporter would depend on.
                int vertices = mesh.vertices != null ? mesh.vertices.Length : 0;
                int indices = mesh.triangles != null ? mesh.triangles.Length : 0;
                totalTris += indices / 3;

                if (vertices > 0 && sample.Line == null)
                {
                    sample.Line = $"'{mesh.name}' on '{owner}' - vertexCount={mesh.vertexCount}, " +
                        $"vertices[]={vertices}, triangles[]={indices}, subMeshes={mesh.subMeshCount}, " +
                        $"uv={(mesh.uv != null ? mesh.uv.Length : 0)}, " +
                        $"normals={(mesh.normals != null ? mesh.normals.Length : 0)}";
                }
            }
            catch (Exception ex)
            {
                ExportPlugin.Logger.LogWarning(
                    $"Mesh '{mesh.name}' claims readable but the read-back threw: {ex.Message}");
            }
        }

        private static void CollectTexture(Material material, string property, Dictionary<int, string> seen)
        {
            try
            {
                if (!material.HasProperty(property)) return;
                var texture = material.GetTexture(property);
                if (texture == null) return;

                int id = texture.GetInstanceID();
                if (seen.ContainsKey(id)) return;

                string format = texture is Texture2D flat ? flat.format.ToString() : texture.GetType().Name;
                seen[id] = $"{texture.name} [{property}] {texture.width}x{texture.height} {format}";
            }
            catch (Exception ex)
            {
                ExportPlugin.Logger.LogWarning($"Reading '{property}' failed: {ex.Message}");
            }
        }
    }
}
