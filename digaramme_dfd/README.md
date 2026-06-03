# Digaramme DFD

Editeur DFD autonome inspire du test `reactflow-dfd-test`, mais avec une interface plus complete :

- trust zones pointillees et courbees
- ajout d'`Actor`, `Process`, `Store`, `Trust Zone`
- renommage des noeuds et des fleches
- import JSON
- export JSON
- export PNG transparent en haute qualite
- suppression via bouton ou touche `Delete`

## Lancer le projet

```bash
cd "digaramme dfd"
npm install
npm run dev
```

## Format JSON

Le projet importe et exporte exactement ce format :

```json
{
  "boundaries": [{ "name": "" }],
  "external_entities": [{ "name": "", "boundary": "" }],
  "processes": [{ "name": "", "boundary": "" }],
  "data_stores": [{ "name": "", "boundary": "" }],
  "data_flows": [
    { "source": "", "target": "", "label": "" }
  ]
}
```

Notes :

- `boundary` est vide si l'element est hors d'une trust boundary.
- `source` et `target` utilisent le `name` des elements.
- en cas d'import, les elements sont reposes automatiquement sur le canvas a partir de cette structure.
