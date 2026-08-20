using System.Collections.Generic;

namespace FIHMapExport
{
    /// <summary>
    /// What the mod can read out of a running level. The geometry itself is missing on
    /// purpose: the game's meshes are not CPU-readable, so vertices come from an offline
    /// rip of the game files instead. This file is the other half - where every piece
    /// actually sits in the played level, including the objects the game instantiates at
    /// runtime, which are in no scene file on disk.
    ///
    /// The two halves are joined by mesh and material NAME (see MeshRef.Signature).
    /// </summary>
    public class SceneDump
    {
        public const int CURRENT_FORMAT_VERSION = 1;

        public int FormatVersion { get; set; } = CURRENT_FORMAT_VERSION;
        public string Scene { get; set; }
        public string ExportedAt { get; set; }

        /// <summary>Which LOD level was kept; the others are dropped (see SceneDumper).</summary>
        public int LodLevel { get; set; }

        public List<MeshRef> Meshes { get; set; } = new List<MeshRef>();
        public List<MaterialRef> Materials { get; set; } = new List<MaterialRef>();
        public List<NodeDump> Nodes { get; set; } = new List<NodeDump>();
        public DumpStats Stats { get; set; } = new DumpStats();
    }

    /// <summary>A unique mesh asset, referenced by index from the nodes that instance it.</summary>
    public class MeshRef
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public int SubMeshCount { get; set; }
        // Metadata Unity keeps even for non-readable meshes. Together with the name it
        // disambiguates the rip when two assets share a name.
        public int VertexCount { get; set; }
        public float[] BoundsCenter { get; set; }
        public float[] BoundsSize { get; set; }
        public bool Readable { get; set; }
    }

    public class MaterialRef
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public string Shader { get; set; }

        // Every texture and colour property the shader declares, by property name.
        //
        // Not just _BaseMap/_MainTex: half of this game's materials are Shader Graphs with
        // their own property names (SG_TrashPiles_MSAO, AZURE Nature/Surface...), and
        // guessing two fixed names left the whole terrain untextured. The offline step
        // picks which one is albedo - it can be re-run, a game session cannot.
        public Dictionary<string, string> Textures { get; set; } = new Dictionary<string, string>();
        public Dictionary<string, int[]> TextureSizes { get; set; } = new Dictionary<string, int[]>();
        public Dictionary<string, float[]> Colors { get; set; } = new Dictionary<string, float[]>();
    }

    /// <summary>One renderer placed in the level.</summary>
    public class NodeDump
    {
        // Stable hierarchy path, same shape the map editor uses for its object sources:
        // names joined by '/', with '#n' appended when siblings share a name.
        public string Path { get; set; }
        public string Name { get; set; }
        public int Mesh { get; set; }
        public int[] Materials { get; set; }

        // World transform, decomposed. Rotation is a quaternion (x,y,z,w) so it survives
        // the trip without the gimbal ambiguity euler angles would add.
        public float[] Pos { get; set; }
        public float[] Rot { get; set; }
        public float[] Scale { get; set; }

        // Two different kinds of "not visible", kept apart because they mean opposite
        // things for the map:
        //
        //   ObjectActive=false   the game streamed this area out because the player was
        //                        far away. It IS part of the level and must be exported.
        //   RendererEnabled=false the object is deliberately invisible - collision proxies
        //                        and spare parts. It must NOT be exported.
        //
        // Collapsing both into one flag put collision boxes on the map.
        public bool ObjectActive { get; set; }
        public bool RendererEnabled { get; set; }

        // Where the renderer actually draws, in world space. For ordinary meshes this is
        // redundant with the transform above, but a SkinnedMeshRenderer is positioned by
        // its bones, not by its own transform - exporting those on their transform left
        // the boosters and buttons scattered around the level in their bind pose.
        public float[] WorldBoundsCenter { get; set; }
        public float[] WorldBoundsSize { get; set; }
        public bool Skinned { get; set; }
        public int Layer { get; set; }
        public string LayerName { get; set; }
    }

    /// <summary>
    /// Where NPCs have been seen, accumulated over a playthrough. Separate from the scene
    /// dump because it is not a snapshot: NPCs spawn as the player comes near, so this is
    /// built up press by press instead of all at once (see NpcRecorder).
    /// </summary>
    public class NpcFile
    {
        public string RecordedAt { get; set; }
        public List<NpcSighting> Sightings { get; set; } = new List<NpcSighting>();
    }

    public class NpcSighting
    {
        public string Name { get; set; }
        public string Path { get; set; }
        public string Scene { get; set; }

        /// <summary>The middle of everything the NPC draws, in world space.</summary>
        public float[] Pos { get; set; }
        public bool Active { get; set; }
        public string RecordedAt { get; set; }
    }

    public class DumpStats
    {
        public int Renderers { get; set; }
        public int Nodes { get; set; }
        public int StreamedOut { get; set; }
        public int RendererOff { get; set; }
        public int SkippedLod { get; set; }
        public int SkippedNoMesh { get; set; }
    }
}
