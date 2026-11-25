# Carnet d'exploration fonctionnelle

Application web de gestion du service d'exploration fonctionnelle (EEG, EEG de sommeil, EFR) :

- **Rendez-vous** : agenda de la semaine, statut prévu / honoré / absent / annulé, passage direct du rendez-vous à l'examen.
- **Registre** : les colonnes du carnet (N°, date, nom, sexe, âge, Ext/Int, PAF/Autres, acte, diagnostic, observations), filtres, export Excel.
- **Archives** : compte rendu par photo (appareil photo du téléphone), PDF ou texte, rattaché à chaque examen ; fiche PDF du compte rendu.
- **Rapports** : mensuel (actes × prise en charge), récapitulatif annuel, synthèse sur période ; export PDF et Excel.

## Architecture

| Élément | Rôle |
|---|---|
| `public/index.html` | Toute l'interface (un seul fichier, aucune compilation) |
| `src/worker.js` | API `/api/*` sur Cloudflare Workers, protégée par identifiant + mot de passe |
| Base **D1** `exploration-fonctionnelle` | Examens, rendez-vous et pièces jointes (photos/PDF jusqu'à 1,9 Mo) |
| `wrangler.jsonc` | Configuration Cloudflare (la base D1 est déjà créée et référencée) |

Les photos sont automatiquement réduites (1800 px, JPEG) avant l'envoi.

## Déploiement sur Cloudflare (compte FAMMSIM)

1. Dans le tableau de bord Cloudflare : **Workers & Pages → Créer → Importer un dépôt** et choisir `Fallthionakh/EXPLORATION_FONCTIONNELLE`.
   - Commande de build : *(vide)* — Commande de déploiement : `npx wrangler deploy`.
2. Une fois le Worker créé : **Paramètres → Variables et secrets → Ajouter** un secret `APP_PASSWORD` (mot de passe de premier démarrage de l’administrateur, et clé de signature des sessions).

### Comptes

- Au premier démarrage, connectez-vous avec l’identifiant **`admin`** et le mot de passe `APP_PASSWORD`.
- Menu **Mon compte** (en haut à droite) : changez votre mot de passe, puis créez le compte **`service`** pour l’équipe.
- Les mots de passe sont hachés (PBKDF2) dans la table D1 `users` ; ils ne sont jamais dans le dépôt.
- Chaque fiche garde qui l’a saisie et qui l’a modifiée en dernier (`saisiPar`, `modifPar`).
- Mot de passe administrateur perdu : dans la console D1, `DELETE FROM users WHERE login = 'admin';` puis reconnectez-vous avec `admin` + `APP_PASSWORD`.
- Ne changez pas `APP_PASSWORD` sans raison : cela déconnecte tout le monde (les comptes restent).
   Sans ce secret, l'API refuse tout accès (sécurité par défaut).
3. Ouvrir l'adresse `https://exploration-fonctionnelle.<votre-sous-domaine>.workers.dev`.

Chaque `git push` sur `main` redéploie automatiquement.

Pour plus de sécurité (données de santé), on peut ajouter **Cloudflare Access** (Zero Trust) devant l'adresse pour n'autoriser que certaines adresses e-mail.

## En local

```bash
npm install
echo "APP_PASSWORD=motdepasse" > .dev.vars
npx wrangler dev
```

Ouvert directement comme fichier (`public/index.html`), l'application fonctionne aussi hors ligne avec un stockage dans le navigateur.
