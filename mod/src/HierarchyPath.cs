using System.Text;
using UnityEngine;

namespace FIHMapExport
{
    /// <summary>
    /// Stable identity for a scene object: the chain of names from the scene root, with
    /// '#n' appended when siblings share a name. Deliberately the same shape the map
    /// editor stores in MapObjectData.Source, so a marker on the web map can point at the
    /// same object a custom map does.
    /// </summary>
    internal static class HierarchyPath
    {
        public static string Of(Transform transform)
        {
            var sb = new StringBuilder();
            Append(transform, sb);
            return sb.ToString();
        }

        private static void Append(Transform transform, StringBuilder sb)
        {
            if (transform.parent != null)
            {
                Append(transform.parent, sb);
                sb.Append('/');
            }

            sb.Append(transform.name);

            int index = SiblingIndexAmongSameName(transform);
            if (index > 0) sb.Append('#').Append(index);
        }

        private static int SiblingIndexAmongSameName(Transform transform)
        {
            var parent = transform.parent;
            int index = 0;

            if (parent == null)
            {
                foreach (var root in transform.gameObject.scene.GetRootGameObjects())
                {
                    if (root.transform == transform) return index;
                    if (root.name == transform.name) index++;
                }

                return 0;
            }

            for (int i = 0; i < parent.childCount; i++)
            {
                var child = parent.GetChild(i);
                if (child == transform) return index;
                if (child.name == transform.name) index++;
            }

            return 0;
        }
    }
}
