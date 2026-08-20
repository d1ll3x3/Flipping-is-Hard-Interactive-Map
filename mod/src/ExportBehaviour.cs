using System;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace FIHMapExport
{
    /// <summary>Polls the hotkey and runs the export work. Does nothing outside a level.</summary>
    public class ExportBehaviour : MonoBehaviour
    {
        // Required by IL2CPP interop.
        public ExportBehaviour(IntPtr ptr) : base(ptr) { }

        void Update()
        {
            if (InputReader.WasPressedThisFrame(ExportPlugin.ProbeKey.Value))
            {
                RunInLevel(SceneProbe.Run);
            }

            if (InputReader.WasPressedThisFrame(ExportPlugin.DumpKey.Value))
            {
                RunInLevel(SceneDumper.Run);
            }

            // gameObject.scene is the DontDestroyOnLoad scene - this behaviour lives on the
            // plugin's host - and it is the only handle on it there is.
            if (InputReader.WasPressedThisFrame(ExportPlugin.NpcKey.Value))
            {
                RunInLevel(_ => NpcRecorder.Run(gameObject.scene));
            }
        }

        // Every export path needs the same guard: the level scene has to be the active one,
        // and a failure must never take the behaviour's Update loop down with it.
        private static void RunInLevel(Action<Scene> work)
        {
            var scene = SceneManager.GetActiveScene();
            if (!scene.name.StartsWith("Scene_Game", StringComparison.Ordinal))
            {
                ExportPlugin.Logger.LogWarning(
                    $"Not in a level (active scene is '{scene.name}') - load a map first.");
                return;
            }

            try
            {
                work(scene);
            }
            catch (Exception ex)
            {
                ExportPlugin.Logger.LogError($"Export failed: {ex}");
            }
        }
    }
}
