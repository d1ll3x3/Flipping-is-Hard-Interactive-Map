using System.Collections.Generic;
using System.Reflection;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;

namespace FIHMapExport
{
    /// <summary>
    /// Single-key polling through the Input System, which is what the game uses.
    ///
    /// Note that the Input System reads physical key positions on a US layout, so a bind
    /// is a position on the keyboard and not the letter printed on the cap.
    /// </summary>
    internal static class InputReader
    {
        // BepInEx's interop does not expose the Keyboard[Key] indexer, so the control is
        // resolved through the property Unity generates for each key, and then cached.
        private static readonly Dictionary<Key, PropertyInfo> Properties = new();

        public static bool WasPressedThisFrame(Key key)
        {
            if (key == Key.None)
            {
                return false;
            }

            KeyControl control = ResolveControl(key);
            return control != null && control.wasPressedThisFrame;
        }

        private static KeyControl ResolveControl(Key key)
        {
            Keyboard keyboard = Keyboard.current;
            if (keyboard == null)
            {
                return null;
            }

            if (!Properties.TryGetValue(key, out PropertyInfo property))
            {
                property = typeof(Keyboard).GetProperty(ToPropertyName(key),
                    BindingFlags.Public | BindingFlags.Instance);

                if (property == null)
                {
                    ExportPlugin.Logger.LogWarning($"Key '{key}' has no control on Keyboard, ignoring it.");
                }

                Properties[key] = property;
            }

            return property?.GetValue(keyboard) as KeyControl;
        }

        // Key.LeftBracket -> leftBracketKey, Key.Space -> spaceKey, Key.A -> aKey
        private static string ToPropertyName(Key key)
        {
            string name = key.ToString();
            return char.ToLowerInvariant(name[0]) + name.Substring(1) + "Key";
        }
    }
}
