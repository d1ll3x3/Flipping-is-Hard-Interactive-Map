using System.IO;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using Il2CppInterop.Runtime.Injection;
using UnityEngine;
using UnityEngine.InputSystem;
using Object = UnityEngine.Object;

namespace FIHMapExport
{
    /// <summary>
    /// Dumps the loaded level to disk so an offline tool can turn it into a single .glb
    /// for the web map. Read-only towards the game: it never spawns, moves or hides
    /// anything, it only walks the hierarchy and reads it.
    /// </summary>
    [BepInPlugin(Guid, "FIH Map Export", "0.1.0")]
    public class ExportPlugin : BasePlugin
    {
        public const string Guid = "com.dani.fihmapexport";

        internal static ManualLogSource Logger { get; private set; }

        internal static ConfigEntry<Key> ProbeKey { get; private set; }
        internal static ConfigEntry<Key> DumpKey { get; private set; }
        internal static ConfigEntry<string> OutputDir { get; private set; }
        internal static ConfigEntry<int> LodLevel { get; private set; }

        public override void Load()
        {
            Logger = Log;

            // Config next to the dll instead of BepInEx\config, so the whole mod stays one
            // folder you can copy between installs and keep your settings.
            string folder = Path.GetDirectoryName(typeof(ExportPlugin).Assembly.Location) ?? Paths.ConfigPath;
            var config = new ConfigFile(Path.Combine(folder, "FIHMapExport.cfg"), true);

            ProbeKey = config.Bind("Keys", "Probe", Key.F10,
                "Writes a report on what the level's geometry looks like from inside the game.");
            DumpKey = config.Bind("Keys", "Dump", Key.F11,
                "Writes scene.json: where every object of the level sits, for the web map.");
            OutputDir = config.Bind("Output", "Directory", Path.Combine(folder, "Export"),
                "Where dumps are written. Point this at the web project to skip copying by hand.");
            LodLevel = config.Bind("Output", "LodLevel", 0,
                "Which LOD to keep for objects that ship several (0 = most detailed). Higher "
                + "values make a much lighter map. Groups with fewer levels are clamped.");

            ClassInjector.RegisterTypeInIl2Cpp<ExportBehaviour>();

            var host = new GameObject("FIHMapExport");
            Object.DontDestroyOnLoad(host);
            host.hideFlags = HideFlags.HideAndDontSave;
            host.AddComponent<ExportBehaviour>();

            Logger.LogInfo($"Loaded. {ProbeKey.Value} probes the level, {DumpKey.Value} dumps it. "
                + $"Output: {OutputDir.Value}");
        }
    }
}
