# FIH Map

Mapa 3D interactivo de **Flipping is Hard**, para anotar skips, tiempos, vídeos y ejemplos
sobre la geometría real del nivel.

El sitio es estático: carga un único `scene.glb` (~5 MB) con todo el nivel y un
`markers.json` con las anotaciones.

## Por qué hay dos mitades

Las mallas del juego no son legibles desde la CPU (`Mesh.vertices` viene vacío en tiempo de
ejecución), así que la geometría no se puede sacar desde un mod. Pero buena parte del nivel
se instancia en runtime — todos los objetos `(Clone)` —, así que tampoco está colocada en
ningún archivo de escena del disco.

Ninguna de las dos fuentes basta por separado, y de ahí el reparto:

| Mitad | Qué aporta | De dónde sale |
|---|---|---|
| `mod/` | dónde está cada objeto del nivel jugado | plugin BepInEx, en el juego |
| AssetRipper | las mallas y las texturas | archivos del juego, offline |
| `tools/` | une ambas en un `scene.glb` | Node |

## Pipeline completo

```bash
cd mod && ./build.bat
```

Compila el plugin y lo despliega en la Demo. Dentro de un nivel:

- `F10` — informe de diagnóstico de la escena (`Export/probe.txt`)
- `F11` — vuelca `Export/scene.json`: la posición de cada objeto

Ambas teclas y la carpeta de salida se configuran en `FIHMapExport.cfg`, junto al DLL.

Copia ese `scene.json` a `raw/` y lanza AssetRipper:

```bash
tools/AssetRipper/AssetRipper.GUI.Free.exe --headless --port 7891
```

Carga en él la carpeta `..._Data` del juego, y después:

```bash
node tools/rip-assets.mjs
```

```bash
node tools/build-glb.mjs
```

El primero descarga una malla `.glb` y una textura `.png` por asset, emparejándolos con el
volcado por nombre y verificándolos por número de vértices. El segundo los ensambla en
`web/public/scene.glb`.

## La web

```bash
cd web && npm install && npm run dev
```

Abre `http://localhost:5173`. Con `?edit=1` aparece el editor: coloca marcadores haciendo
clic sobre el nivel, rellena sus datos y exporta un `markers.json` para commitear. No hay
backend a propósito.

### Quién puede editar

`?edit=1` pide una frase de paso antes de abrir el editor. **No es autenticación** y no
pretende serlo: el sitio es estático y todo el JavaScript es público, así que lo único que
hace es que un visitante que dé con el parámetro no se encuentre el editor abierto. En el
repositorio solo está el SHA-256 (`web/src/access.js`), nunca la frase; se comparte por otro
canal con quien deba editar.

Quien controla de verdad lo que llega al mapa son los permisos del repositorio: el editor
solo descarga un `markers.json`, y ese archivo entra por un commit. Para cambiar la frase,
sustituye el hash de `web/src/access.js` por el que imprime el comando documentado ahí.

## Detalles que costaron encontrar

Todos están comentados en el código, pero conviene saberlos antes de tocar nada:

- **AssetRipper no mete las submallas de una malla en una sola malla glTF.** Escribe un nodo
  raíz con un hijo por submalla (`SubMesh_0`, `SubMesh_1`…), cada uno apuntando a su propia
  malla. Leer solo la primera se lleva por delante todo lo demás en 65 de las 337 mallas del
  nivel: el microondas se quedaba en su panel frontal, el boost pad en el muelle, la radio en
  la antena y los trozos combinados de Military en casi nada.
- **Una misma malla se pinta de varias formas.** 41 mallas se instancian con materiales
  distintos y la diferencia es el objeto entero: `SM_Phone_v4_Full_LOD0` es un móvil con
  `M_Phone_Base_Demo` y un microondas con `M_Phone_Microwave`; `SM_GroundBlock_07` es roca o
  hierba. Hay que crear una variante de malla por juego de materiales, no elegir uno.
- **AssetRipper refleja el eje X**, no el Z, al convertir de Unity a glTF. Aplicar la
  convención habitual (negar Z) deja el mapa entero en espejo respecto a su propia
  geometría. Se verificó comparando los bounds de Unity con los del glTF ripeado.
- **El color no está en `_MainTex`.** En los shaders `SG_Standard_MSAO` esa textura es solo
  un mapa de detalle casi blanco; el color real lo pone `T_Global_Atlas`, una paleta
  direccionada por **UV1**.
- **Esa paleta no se puede reescalar, comprimir con pérdida ni interpolar**, y sus UV1 no se
  pueden cuantizar: cada texel es una celda de color distinta, así que cualquier mezcla
  entre celdas vecinas inventa colores que no existen en el juego.

## Despliegue

`git push` a `main` publica en GitHub Pages mediante `.github/workflows/pages.yml`. El
workflow pasa el nombre del repositorio como `BASE` para que las rutas resuelvan bien.

## Licencia y assets

El código es propio. Los assets del juego pertenecen a **Elegant Horse Studios**.

`raw/` está en `.gitignore` — son cientos de MB de mallas y texturas en crudo, y se
regeneran con `rip-assets.mjs`. Pero **`web/public/scene.glb` sí tiene que estar
commiteado**: el workflow de Pages no puede reconstruirlo, porque eso requiere el juego
instalado y una sesión en marcha. Son ~5 MB, sin problema para git.

Eso significa que publicar el sitio distribuye geometría y texturas del juego, aunque sea
en forma derivada y reducida. Si va a ser público, avisa antes al estudio.
