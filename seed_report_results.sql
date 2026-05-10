-- Populate report_results table with sample data for testing
-- Run this SQL script in your PostgreSQL database

BEGIN;

-- Insert sample results for existing reports that don't have results yet
INSERT INTO report_results (
    report_id, 
    app_name, 
    developer_name, 
    application_description,
    selected_threats,
    created_by,
    created_by_username,
    created_by_email
)
SELECT 
    r.id,
    r.title,
    COALESCE(r.generated_by_username, 'Analyste'),
    COALESCE(r.description, 'Description indisponible.'),
    '[
        {
            "name": "SQL Injection",
            "description": "Dans l''application, un attaquant injecte des requêtes SQL malveillantes via des entrées utilisateur non sécurisées.",
            "attack_scenarios": [
                "Injection via formulaire de connexion pour contourner l''authentification",
                "Injection dans les paramètres de recherche pour extraire des données sensibles",
                "Injection dans les requêtes API pour modifier ou supprimer des données"
            ],
            "mitigations": [
                "Utiliser exclusivement des requêtes préparées (prepared statements)",
                "Valider strictement toutes les entrées utilisateur côté serveur",
                "Appliquer le principe du moindre privilège aux comptes d''accès à la base de données"
            ]
        },
        {
            "name": "Broken Authentication",
            "description": "Les mécanismes d''authentification présentent des failles permettant la prise de contrôle de comptes.",
            "attack_scenarios": [
                "Attaque par force brute sur l''interface de connexion",
                "Réutilisation de credentials compromis (credential stuffing)",
                "Manipulation ou usurpation de tokens d''authentification"
            ],
            "mitigations": [
                "Imposer un MFA robuste pour tous les comptes sensibles",
                "Appliquer un rate limiting strict sur les endpoints d''authentification",
                "Vérifier systématiquement la signature cryptographique des tokens (JWT)"
            ]
        },
        {
            "name": "Cross-Site Scripting (XSS)",
            "description": "Un attaquant injecte du code JavaScript malveillant via des entrées utilisateur non filtrées.",
            "attack_scenarios": [
                "Injection de scripts dans les champs de recherche affichés à d''autres utilisateurs",
                "Injection via les noms de fichiers ou commentaires",
                "Vol de cookies de session d''utilisateurs authentifiés"
            ],
            "mitigations": [
                "Implémenter un mécanisme d''échappement systématique de toutes les données en sortie",
                "Déployer un WAF avec des règles de détection et blocage des attaques XSS",
                "Activer les attributs de sécurité des cookies (HttpOnly, Secure, SameSite)"
            ]
        },
        {
            "name": "Broken Object Level Authorization",
            "description": "L''API n''applique pas un contrôle de propriété adéquat sur chaque ressource accédée.",
            "attack_scenarios": [
                "Accès à des ressources d''autres utilisateurs en modifiant l''identifiant dans la requête",
                "Énumération des identifiants de ressources séquentiels",
                "Modification d''objets sans autorisation adéquate"
            ],
            "mitigations": [
                "Vérifier côté serveur que l''identifiant de ressource appartient à l''utilisateur",
                "Générer les identifiants en UUID v4 aléatoires pour empêcher l''énumération",
                "Utiliser des ACL (Access Control Lists) ou RBAC pour chaque ressource"
            ]
        }
    ]'::jsonb,
    r.generated_by,
    r.generated_by_username,
    r.generated_by_email
FROM reports r
WHERE r.id NOT IN (SELECT report_id FROM report_results)
LIMIT 10;

COMMIT;

-- Verify insertion
SELECT report_id, app_name, developer_name, 
       jsonb_array_length(selected_threats) as threat_count,
       updated_at
FROM report_results
ORDER BY updated_at DESC
LIMIT 5;
