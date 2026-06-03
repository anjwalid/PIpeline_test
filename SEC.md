# SEC

## Corrections appliquees

### Authentification et autorisation
- Verification reelle des JWT Keycloak via JWKS, `issuer`, expiration et claims au lieu d'un simple decode base64.
  Fichier: [backend/app/core/auth.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/auth.py:36)
  Lignes clefs: 36, 45
- Verrouillage explicite des endpoints admin au role `admin`.
  Fichiers:
  [backend/app/core/auth.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/auth.py:154),
  [backend/app/api/admin_catalog.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_catalog.py:41),
  [backend/app/api/admin_audit.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_audit.py:26),
  [backend/app/api/admin_questionnaire.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_questionnaire.py:31),
  [backend/app/api/admin_cve_graph.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_cve_graph.py:25)

### Surface HTTP
- CORS remplace par une allowlist configurable.
  Fichier: [backend/app/main.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/main.py:55)
- Filtrage des `Host` autorises avec `TrustedHostMiddleware`.
  Fichier: [backend/app/main.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/main.py:46)
- Ajout de headers de securite backend.
  Fichier: [backend/app/main.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/main.py:63)
- Ajout de headers de securite frontend Nginx.
  Fichier: [frontend/nginx.conf](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/frontend/nginx.conf:4)

### Controle d'acces aux artefacts
- Les endpoints temporaires `/download-report` et `/download-dfd` verifient maintenant le proprietaire courant.
  Fichier: [backend/app/api/analysis.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/analysis.py:21)
- Le proprietaire du dernier artefact genere est memorise cote backend.
  Fichier: [backend/app/services/analysis_service.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/services/analysis_service.py:38)

### Upload et fichiers
- Verification stricte du format image reel pour les DFD, pas seulement l'extension.
  Fichier: [backend/app/services/report_management_service.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/services/report_management_service.py:64)
- Limite de taille sur l'upload DFD.
  Fichier: [backend/app/services/report_management_service.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/services/report_management_service.py:1060)

### Fuites d'information
- Les erreurs internes ne renvoient plus la cause brute au client par defaut.
  Fichiers:
  [backend/app/main.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/main.py:89),
  [backend/app/core/exceptions.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/exceptions.py:18),
  [backend/app/api/analysis.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/analysis.py:58),
  [backend/app/services/report_management_service.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/services/report_management_service.py:1366)

### Protection anti-abus
- Rate limiting en memoire pour `analyze`, `secops-chat` et les routeurs admin.
  Fichiers:
  [backend/app/core/rate_limit.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/rate_limit.py:13),
  [backend/app/api/analysis.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/analysis.py:14),
  [backend/app/api/secops_chat.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/secops_chat.py:12),
  [backend/app/api/admin_catalog.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_catalog.py:33),
  [backend/app/api/admin_audit.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_audit.py:20),
  [backend/app/api/admin_questionnaire.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_questionnaire.py:25),
  [backend/app/api/admin_cve_graph.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/api/admin_cve_graph.py:20)

### Gouvernance LLM
- Support d'un passage par proxy LiteLLM pour centraliser les appels, les cles et les politiques.
  Fichiers:
  [backend/app/core/config.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/config.py:44),
  [backend/app/services/llm_clients.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/services/llm_clients.py:52)

## Vulnerabilites ou risques encore ouverts

### Artefacts sensibles dans le depot
- Des PDF, HTML generes, sorties intermediaires et potentiellement des donnees metier restent versionnes sous `backend/resources/pdf`, `backend/resources/out` et autres fichiers racine.
  Risque: fuite d'information, exposition de rapports internes, pollution du depot.

### Secrets et valeurs par defaut
- Le projet garde des valeurs par defaut faibles dans la config applicative et la documentation (`DB_PASSWORD=password`, exemples Neo4j, endpoints locaux).
  Fichier concerne: [backend/app/core/config.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/config.py:30)
  Risque: mauvais deploiement si les variables d'environnement ne sont pas surchargees.

### Rate limiting non distribue
- Le limiteur actuel est en memoire locale.
  Fichier: [backend/app/core/rate_limit.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/rate_limit.py:13)
  Risque: inefficace en multi-instance ou apres restart.
  Recommandation: Redis ou API Gateway.

### Absence de verification antivirus / contenu avance sur upload
- Le DFD est verifie comme image valide, mais il n'y a pas encore d'analyse AV, de re-encodage systematique ni de sandbox.
  Fichier: [backend/app/services/report_management_service.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/services/report_management_service.py:1067)

### Transport securise non force
- Le code ajoute des headers et des restrictions, mais n'impose pas directement TLS/HSTS au niveau reverse proxy de production.
  Fichier concerne: [frontend/nginx.conf](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/frontend/nginx.conf:1)

### LiteLLM non encore impose
- Le backend sait passer par LiteLLM, mais garde un fallback SDK direct si `LITELLM_ENABLED=false`.
  Fichiers:
  [backend/app/core/config.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/core/config.py:44),
  [backend/app/services/llm_clients.py](/c:/Users/walid/Desktop/AWB_PROJECTS/Version_sec/backend/app/services/llm_clients.py:144)
  Recommandation: en production, forcer `LITELLM_ENABLED=true` et retirer les cles directes si l'architecture cible passe uniquement par le proxy.

## Variables a renseigner
- `CORS_ALLOWED_ORIGINS`
- `TRUSTED_HOSTS`
- `KEYCLOAK_ISSUER`
- `KEYCLOAK_CERTS_URL`
- `KEYCLOAK_AUDIENCE`
- `MAX_DFD_UPLOAD_BYTES`
- `ANALYSIS_RATE_LIMIT_COUNT`
- `ANALYSIS_RATE_LIMIT_WINDOW_SECONDS`
- `SECOPS_CHAT_RATE_LIMIT_COUNT`
- `SECOPS_CHAT_RATE_LIMIT_WINDOW_SECONDS`
- `ADMIN_RATE_LIMIT_COUNT`
- `ADMIN_RATE_LIMIT_WINDOW_SECONDS`
- `LITELLM_ENABLED`
- `LITELLM_PROXY_URL`
- `LITELLM_API_KEY`
- `LITELLM_MISTRAL_MODEL`
- `LITELLM_GEMINI_MODEL`
- `LITELLM_OLLAMA_MODEL`
