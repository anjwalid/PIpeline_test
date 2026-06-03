# APP_PFE_AWB

> Plateforme de modelisation des menaces assistee par IA pour les infrastructures AWB.

[![Security - Threat Modeling](https://img.shields.io/badge/Security-Threat%20Modeling-red?style=for-the-badge)](https://atlas.mitre.org/)
[![Backend - FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688?style=for-the-badge)](https://fastapi.tiangolo.com/)
[![Frontend - React](https://img.shields.io/badge/Frontend-React%20%2B%20TypeScript-1f6feb?style=for-the-badge)](https://react.dev/)
[![Auth - Keycloak](https://img.shields.io/badge/Auth-Keycloak-4b2e83?style=for-the-badge)](https://www.keycloak.org/)

## Apercu

`APP_PFE_AWB` est une application de fin d'etudes orientee cybersecurite qui automatise une partie du processus de threat modeling pour des cas d'usage bancaires. La plateforme permet de decrire une application, structurer un questionnaire de securite, generer un DFD, produire une analyse assistee par LLM, puis consolider un rapport exploitable par les equipes techniques, SecOps et management.

Le projet s'appuie sur une architecture separee `FastAPI + React`, une authentification `Keycloak`, une persistance relationnelle pour les analyses et rapports, ainsi que des briques optionnelles pour l'enrichissement CVE, les graphes Neo4j et l'export documentaire.

## Objectifs

- Industrialiser la modelisation des menaces dans un contexte AWB.
- Accelerer l'identification des risques applicatifs et des surfaces d'attaque.
- Centraliser les rapports, les versions et les validations.
- Fournir un support d'analyse assiste par IA pour la revue SecOps.

## Fonctionnalites principales

- Authentification et gestion des acces par roles via `Keycloak`.
- Saisie d'un contexte applicatif et d'un questionnaire de securite.
- Generation automatique de `DFD` a partir d'une representation structuree.
- Production d'analyses de menaces et de recommandations.
- Gestion des rapports avec historique, regeneration et telechargement.
- Tableau de bord manager pour le suivi des rapports.
- Chatbot `SecOps` pour assister la revue et l'interpretation des resultats.
- Capacites d'enrichissement CVE / graphe de connaissance via les modules dedies.

## Workflow metier

1. L'utilisateur authentifie soumet le contexte applicatif.
2. Le backend consolide les reponses du questionnaire et les metadonnees du projet.
3. Un DFD est genere et archive avec les artefacts du rapport.
4. Les services d'analyse produisent les menaces, impacts et exigences de remediations.
5. Le rapport est relu, modifie si necessaire, versionne puis partage aux parties prenantes.

## Architecture du depot

```text
.
|-- backend/        API FastAPI, services d'analyse, rapports, auth, export
|-- frontend/       Interface React/TypeScript, vues par role, integration Keycloak
|-- CVE-KGRAG/      Module d'enrichissement CVE / RAG / knowledge graph
|-- neo4j-cve/      Scripts et compose lies a l'alimentation Neo4j
|-- Files/          Jeux de donnees et fichiers bruts
|-- outputs/        Sorties et artefacts divers
`-- docker-compose.yml
```

## Stack technique

| Couche | Technologies |
| :-- | :-- |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Backend | FastAPI, Uvicorn, Pydantic |
| Authentification | Keycloak |
| Base relationnelle | PostgreSQL |
| Graphe / CVE | Neo4j, NVD API, modules CVE-KGRAG |
| IA / LLM | Mistral, Gemini, Ollama selon configuration |
| Stockage objet | MinIO |
| Reporting | Jinja2, WeasyPrint, export PDF/HTML |
| DFD | `pytm` + `graphviz` |

## Roles applicatifs

- `secops_engineer` : execution des analyses, revue technique, iteration sur les resultats.
- `manager` : consultation, suivi, validation et supervision des rapports.
- `admin` : administration des catalogues, questionnaires et composants de gouvernance.

## Prerequis

Avant le lancement, verifier la disponibilite de :

- `Python 3.11+`
- `Node.js 18+`
- `PostgreSQL`
- `Graphviz` installe au niveau systeme
- `Keycloak` pour l'authentification
- `MinIO` si vous souhaitez stocker et servir les rapports via objet storage
- `Neo4j` si vous activez les fonctionnalites graphe / CVE

## Configuration

### Backend

Creer le fichier `backend/.env` a partir de `backend/.env.example`, puis completer les variables selon votre environnement :

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=catalog_AWB
DB_USER=admin
DB_PASSWORD=admin123

MISTRAL_API_KEY=
MISTRAL_MODEL=mistral-medium-latest
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

ENDPOINT=http://localhost:9000
ACCESS_KEY=minioadmin
SECRET_KEY=minioadmin123
BUCKET=app-reports
```

Variables egalement supportees par l'application :

- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- `NEO4J_ENABLED`
- `NVD_API_KEY`
- `CVE_SYNC_ENABLED`
- `CVE_SYNC_INTERVAL_MINUTES`
- `OLLAMA_BASE_URL`
- `OLLAMA_JUDGE_MODEL`

### Frontend

Le frontend consomme les variables Vite suivantes :

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_KEYCLOAK_URL=http://localhost:8080
VITE_KEYCLOAK_REALM=myrealm
VITE_KEYCLOAK_CLIENT_ID=frontend-app
```

## Installation et lancement

### 1. Cloner le projet

```bash
git clone https://github.com/votre-organisation/APP_PFE_AWB.git
cd APP_PFE_AWB
```

### 2. Lancer le backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Le backend sera accessible sur `http://localhost:8000`.

### 3. Lancer le frontend

Dans un second terminal :

```bash
cd frontend
npm install
npm run dev
```

Le frontend sera accessible sur `http://localhost:5173`.

## Lancement via Docker

Un fichier `docker-compose.yml` est present a la racine pour le frontend et le backend. Il suppose notamment :

- un fichier `backend/.env` deja renseigne
- un reseau Docker externe nomme `app-network`
- les services annexes requis disponibles selon votre configuration

Exemple :

```bash
docker network create app-network
docker compose up --build
```

## Endpoints utiles

- `GET /health` : verification de sante du backend
- `POST /analyses` : creation d'une analyse
- `GET /reports` : liste des rapports
- `GET /reports/me` : rapports de l'utilisateur courant
- `POST /secops-chat/message` : interaction avec le chatbot SecOps

## Artefacts generes

L'application peut produire :

- diagrammes `DFD` au format image
- rapports `HTML` et `PDF`
- historiques de versions
- resultats d'analyse exploitables pour revue securite

Les sorties sont principalement stockees dans `backend/resources/out/` et `backend/resources/pdf/`.

## Modules complementaires

### `CVE-KGRAG`

Ce module regroupe des composants lies au traitement de CVE, a la construction d'un knowledge graph et a des mecanismes de RAG. Il peut etre exploite pour enrichir les analyses de securite avec du contexte vulnerabilite.

### `neo4j-cve`

Ce dossier contient des scripts et configurations dedies au chargement et a l'exploitation des donnees CVE dans `Neo4j`.

## Equipe PFE

| Collaborateur | Role principal |
| :-- | :-- |
| Nada Bellaali | R&D Engineer |
| Saaflaoukete Abdelilah | Cybersecurity Engineer |

## Pistes d'amelioration

- formaliser la documentation d'architecture et des flux applicatifs
- ajouter une procedure complete d'initialisation Keycloak
- fournir un jeu de donnees de demonstration
- industrialiser les tests backend et frontend
- completer la CI/CD et les controles qualite

## Licence

A definir selon le cadre de diffusion du projet AWB / PFE.
