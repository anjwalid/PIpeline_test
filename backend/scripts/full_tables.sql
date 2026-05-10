/*
Traçabilité du schéma de données
Fichier : backend/scripts/full_tables.sql
Date : 2026-05-10

Objectif :
- centraliser une description lisible des tables métier visibles dans les schémas
- garder une trace du rôle fonctionnel de chaque table
- faciliter la maintenance du pipeline questionnaire -> analyse -> rapport

Vue d'ensemble :
1. Bloc questionnaire
   questionnaire -> questionnaire_step -> question -> question_option
   question -> question_visibility_rule

2. Bloc analyse
   analysis_request -> analysis_answer
   questionnaire_answer_context enrichit les réponses avec du contexte LLM et DFD

3. Bloc catalogue de menaces
   menace -> mitigation
   menace -> scenario_attaque
   menace <-> reference_menace via menace_reference

4. Bloc reporting
   reports -> report_results
   reports -> report_result_versions
   reports -> report_annotations
   reports -> report_status_history
*/

/*
===============================================================================
BLOC QUESTIONNAIRE
===============================================================================

Table: questionnaire
Rôle:
- représente un questionnaire fonctionnel versionné
- porte l'identité métier du questionnaire via code, nom, version et statut
- permet d'activer une version donnée via is_active

Colonnes clés:
- id: identifiant technique
- code: identifiant fonctionnel du questionnaire
- name: libellé du questionnaire
- version: numéro de version
- status: état de publication ou d'usage
- is_active: version actuellement exploitable

Relations:
- 1 questionnaire possède plusieurs questionnaire_step
- 1 questionnaire peut être utilisé par plusieurs analysis_request

Table: questionnaire_step
Rôle:
- découpe un questionnaire en étapes d'affichage ou de saisie
- ordonne les sections du formulaire

Colonnes clés:
- id: identifiant technique
- questionnaire_id: FK vers questionnaire
- code: code fonctionnel de l'étape
- title: titre affiché
- step_order: ordre d'affichage

Relations:
- 1 questionnaire_step appartient à 1 questionnaire
- 1 questionnaire_step possède plusieurs question

Table: question
Rôle:
- stocke chaque question d'une étape de questionnaire
- définit le type de donnée attendu et les règles d'obligation

Colonnes clés:
- id: identifiant technique
- step_id: FK vers questionnaire_step
- code: code fonctionnel utilisé par le backend
- label: libellé affiché à l'utilisateur
- help_text: aide contextuelle
- question_type: type de réponse attendu
- is_required: indique si la question est obligatoire
- display_order: ordre dans l'étape
- is_active: permet de désactiver une question sans la supprimer

Relations:
- 1 question appartient à 1 questionnaire_step
- 1 question peut avoir plusieurs question_option
- 1 question peut être ciblée par plusieurs question_visibility_rule
- 1 question peut dépendre d'une autre question via question_visibility_rule.depends_on_question_id

Table: question_option
Rôle:
- porte les choix possibles pour les questions à sélection
- sépare le libellé affiché de la valeur technique enregistrée

Colonnes clés:
- id: identifiant technique
- question_id: FK vers question
- label: libellé visible
- value: valeur technique persistée
- display_order: ordre d'affichage

Relations:
- plusieurs options appartiennent à une question

Table: question_visibility_rule
Rôle:
- définit l'affichage conditionnel d'une question selon la réponse d'une autre
- permet de construire un questionnaire dynamique

Colonnes clés:
- id: identifiant technique
- question_id: question à afficher ou masquer
- depends_on_question_id: question dont dépend la règle
- operator: opérateur de comparaison
- expected_value: valeur qui active la règle

Relations:
- la règle pointe vers la question cible
- la règle pointe aussi vers la question déclenchante
*/

/*
===============================================================================
BLOC ANALYSE
===============================================================================

Table: analysis_request
Rôle:
- enregistre une demande d'analyse soumise depuis un questionnaire
- conserve le contexte initial de l'application à analyser
- trace le statut du pipeline d'analyse

Colonnes clés:
- id: identifiant technique de la demande
- app_name: nom de l'application
- app_description: description initiale libre
- questionnaire_id: questionnaire utilisé
- questionnaire_version: version figée au moment de l'analyse
- status: état de traitement
- created_at / updated_at: horodatage de suivi

Relations:
- 1 analysis_request référence 1 questionnaire
- 1 analysis_request possède plusieurs analysis_answer

Usage applicatif:
- créée au début du pipeline dans AnalysisRepository.create_analysis_request
- passe par des statuts comme submitted, processing, completed, failed

Table: analysis_answer
Rôle:
- stocke les réponses données pour une demande d'analyse
- supporte plusieurs formats de réponse selon le type de question

Colonnes clés:
- id: identifiant technique
- analysis_request_id: FK vers analysis_request
- question_code: code fonctionnel de la question
- answer_text: réponse texte
- answer_boolean: réponse booléenne
- answer_json: réponse multiple ou structurée

Relations:
- plusieurs réponses appartiennent à une analysis_request

Usage applicatif:
- alimente la construction du contexte consolidé
- sert d'entrée à la génération de description, DFD et analyse de menaces

Table: questionnaire_answer_context
Rôle:
- associe une réponse de questionnaire à un enrichissement sémantique
- fournit des phrases de contexte pour le LLM et des indices pour le diagramme

Colonnes clés:
- id: identifiant technique
- questionnaire_code: code du questionnaire concerné
- question_code: code de la question
- option_value: valeur de réponse déclenchante
- context_category: catégorie métier ou technique
- llm_sentence: phrase injectée dans le contexte LLM
- diagram_hint: indice orienté DFD

Relations:
- table de mapping logique entre questionnaire, question et valeur de réponse

Usage applicatif:
- lue dans AnalysisRepository.get_answer_context_entries
- utilisée dans AnalysisService._build_context_bundle
*/

/*
===============================================================================
BLOC CATALOGUE DE MENACES
===============================================================================

Table: menace
Rôle:
- table centrale du catalogue de menaces
- contient la menace de référence utilisée pendant le threat modeling

Colonnes clés:
- id_menace: identifiant technique
- nom_menace: nom de la menace
- description: description de référence
- reference_menace: code ou référence courte de la menace

Relations:
- 1 menace possède plusieurs mitigation
- 1 menace possède plusieurs scenario_attaque
- 1 menace peut être liée à plusieurs reference_menace via menace_reference

Table: mitigation
Rôle:
- stocke les mesures de réduction du risque rattachées à une menace

Colonnes clés:
- id_mitigation: identifiant technique
- id_menace: FK vers menace
- description_mitigation: mesure proposée
- conditions_mitigation: contexte ou conditions d'application

Relations:
- plusieurs mitigations appartiennent à une menace

Table: scenario_attaque
Rôle:
- décrit les scénarios d'attaque possibles pour une menace donnée

Colonnes clés:
- id_scenario: identifiant technique
- id_menace: FK vers menace
- description_scenario: scénario d'attaque
- conditions_scenario: conditions favorisant ou déclenchant le scénario

Relations:
- plusieurs scénarios appartiennent à une menace

Table: reference_menace
Rôle:
- référentiel documentaire des sources externes ou normatives d'une menace

Colonnes clés:
- id_reference: identifiant technique
- reference_menace: code unique de référence
- nom_reference: nom long de la source
- lien: URL ou lien documentaire

Relations:
- liée aux menaces via la table d'association menace_reference

Table: menace_reference
Rôle:
- table de jointure entre menace et reference_menace
- permet de rattacher plusieurs références documentaires à une même menace

Colonnes clés:
- id_menace: FK vers menace
- id_reference: FK vers reference_menace
*/

/*
===============================================================================
BLOC REPORTING ET VALIDATION
===============================================================================

Table: reports
Rôle:
- représente le rapport PDF généré et suivi dans le workflow de validation
- contient les métadonnées de stockage, de génération et de validation

Colonnes clés:
- id: identifiant UUID du rapport
- title: titre métier
- description: résumé textuel
- file_name: nom du fichier
- file_type: type MIME ou nature du document
- file_size: taille du fichier
- minio_bucket / minio_object_key: emplacement objet du rapport
- status: état du workflow de validation
- generated_by*: auteur de génération
- validated_by*: validateur éventuel
- generated_at / validated_at / created_at / updated_at: horodatages de suivi

Relations:
- 1 report possède 1 report_results
- 1 report possède plusieurs report_result_versions
- 1 report possède plusieurs report_annotations
- 1 report possède plusieurs report_status_history

Table: report_results
Rôle:
- stocke la représentation exploitable des résultats d'analyse associés à un rapport
- sert de source de vérité éditable pour régénérer un PDF

Colonnes clés:
- report_id: PK et FK vers reports
- app_name: nom de l'application
- developer_name: nom de l'analyste ou auteur
- application_description: description consolidée
- selected_threats: menaces retenues au format JSONB
- dfd_image_path: chemin ou URI du DFD
- dfd_reference: identifiant de la figure DFD
- version_number: version courante des résultats
- created_by* / created_at / updated_at: traçabilité d'édition

Relations:
- 1 ligne par report
- historisée dans report_result_versions

Table: report_result_versions
Rôle:
- historise les versions successives de report_results
- permet la traçabilité des régénérations et modifications de contenu

Colonnes clés:
- id: identifiant technique
- report_id: FK vers reports
- version_number: numéro de version
- version_label: libellé fonctionnel de version
- app_name / developer_name / application_description: snapshot textuel
- selected_threats: snapshot JSONB des menaces
- dfd_image_path / dfd_reference: snapshot du diagramme
- created_by* : auteur de la version
- change_reason: motif de changement
- created_at: date de création de la version

Contrainte notable:
- unicité sur (report_id, version_number)

Table: report_annotations
Rôle:
- mémorise les commentaires saisis pendant le cycle de revue ou de validation

Usage métier:
- permet de garder les remarques du manager ou du réviseur
- peut servir de justification lors d'un statut NEEDS_CHANGES ou REJECTED

Table: report_status_history
Rôle:
- journalise tous les changements de statut d'un rapport
- constitue la trace d'audit du workflow documentaire

Usage métier:
- permet de savoir qui a changé le statut, quand, et avec quel commentaire
*/

/*
===============================================================================
NOTES DE LECTURE
===============================================================================

- Les descriptions ci-dessus sont alignées sur les schémas fournis et sur l'usage
  observé dans le code backend.
- Ce fichier sert de référence documentaire; il n'est pas destiné à être exécuté.
- Si le schéma évolue, mettre à jour cette documentation en même temps que les
  migrations SQL et les repositories concernés.
*/
