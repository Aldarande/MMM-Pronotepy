# -*- coding: utf-8 -*-
# MMM-Pronotepy — module MagicMirror² pour Pronote
# Copyright (C) 2024-2026 Aldarande
# Licensed under the MIT License. See LICENSE for details.
"""
Tests du côté Python des comptes multiples.

Le nommage des comptes est réparti sur trois implémentations : Node normalise
(`lib/accounts.js`), la page de configuration en fait autant pour l'aperçu, et
le pont valide avant d'en faire un chemin. Une divergence entre elles ne se
verrait pas au démarrage — elle se verrait le jour où un jeton serait cherché
au mauvais endroit, et se lirait « rescannez un QR Code » sur un compte qui
n'avait rien demandé. D'où le test de contrat en fin de fichier.
"""

import io
import json
import os
import re

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Choix du compte
# ─────────────────────────────────────────────────────────────────────────────

class TestSetAccount:
    def test_chaque_compte_a_son_fichier(self, bridge):
        bridge.set_account("college-alice")
        alice = bridge.TOKEN_FILE
        bridge.set_account("lycee-hugo")

        assert alice != bridge.TOKEN_FILE
        assert alice.endswith("tokens-college-alice.json")
        assert bridge.TOKEN_FILE.endswith("tokens-lycee-hugo.json")

    def test_le_compte_par_defaut(self, bridge):
        for absent in (None, "", 42, [], {}):
            assert bridge.set_account(absent) == bridge.ACCOUNT_DEFAULT
        assert bridge.TOKEN_FILE.endswith("tokens-default.json")

    @pytest.mark.parametrize("hostile", [
        "../../etc/passwd",
        "compte/../autre",
        "/etc/shadow",
        "..",
        "Collège",          # non normalisé : Node aurait dû le faire
        "AVEC-MAJUSCULES",
        "espace ici",
        "x" * 49,
    ])
    def test_une_cle_douteuse_ne_devient_jamais_un_chemin(self, bridge, hostile, capsys):
        """Ce qui entre dans un chemin de fichier ne se prend pas sur parole,
        fût-elle celle de notre propre code."""
        assert bridge.set_account(hostile) == bridge.ACCOUNT_DEFAULT
        assert os.path.dirname(bridge.TOKEN_FILE) == bridge.CACHE_DIR
        # Le repli est signalé : un compte qui bascule en silence sur
        # « default » écrirait ses jetons par-dessus ceux d'un autre.
        assert bridge.WARN_PREFIX in capsys.readouterr().err

    def test_une_cle_valide_ne_declenche_aucun_avertissement(self, bridge, capsys):
        assert bridge.set_account("college-alice") == "college-alice"
        assert bridge.WARN_PREFIX not in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────────────
# Cloisonnement
# ─────────────────────────────────────────────────────────────────────────────

class TestCloisonnement:
    def test_les_jetons_ne_se_melangent_pas(self, bridge, tmp_path, monkeypatch):
        monkeypatch.setattr(bridge, "CACHE_DIR", str(tmp_path))

        bridge.set_account("college-alice")
        bridge.save_tokens({"username": "parent-college"})
        bridge.set_account("lycee-hugo")
        bridge.save_tokens({"username": "eleve-lycee"})

        bridge.set_account("college-alice")
        assert bridge.load_tokens()["username"] == "parent-college"
        bridge.set_account("lycee-hugo")
        assert bridge.load_tokens()["username"] == "eleve-lycee"

    def test_un_compte_inconnu_n_a_pas_de_jetons(self, bridge, tmp_path, monkeypatch):
        monkeypatch.setattr(bridge, "CACHE_DIR", str(tmp_path))
        bridge.set_account("jamais-configure")
        assert bridge.load_tokens() is None


# ─────────────────────────────────────────────────────────────────────────────
# Reprise du fichier historique
# ─────────────────────────────────────────────────────────────────────────────

class TestReprise:
    def test_le_compte_par_defaut_retrouve_l_ancien_fichier(self, bridge, tmp_path, monkeypatch):
        """Node renomme tokens.json au démarrage, mais le pont peut être lancé
        à la main : mieux vaut le trouver que réclamer un rescan."""
        monkeypatch.setattr(bridge, "CACHE_DIR", str(tmp_path))
        monkeypatch.setattr(bridge, "LEGACY_TOKEN_FILE", str(tmp_path / "tokens.json"))
        (tmp_path / "tokens.json").write_text(
            json.dumps({"username": "parent.exemple"}), encoding="utf-8")

        bridge.set_account("default")
        assert bridge.load_tokens()["username"] == "parent.exemple"

    def test_le_fichier_du_compte_prime_sur_l_ancien(self, bridge, tmp_path, monkeypatch):
        monkeypatch.setattr(bridge, "CACHE_DIR", str(tmp_path))
        monkeypatch.setattr(bridge, "LEGACY_TOKEN_FILE", str(tmp_path / "tokens.json"))
        (tmp_path / "tokens.json").write_text('{"username": "ancien"}', encoding="utf-8")
        (tmp_path / "tokens-default.json").write_text('{"username": "neuf"}', encoding="utf-8")

        bridge.set_account("default")
        assert bridge.load_tokens()["username"] == "neuf"

    def test_les_autres_comptes_ignorent_l_ancien_fichier(self, bridge, tmp_path, monkeypatch):
        """Sinon un compte fraîchement créé hériterait des jetons du compte
        principal, et écrirait par-dessus au premier renouvellement."""
        monkeypatch.setattr(bridge, "CACHE_DIR", str(tmp_path))
        monkeypatch.setattr(bridge, "LEGACY_TOKEN_FILE", str(tmp_path / "tokens.json"))
        (tmp_path / "tokens.json").write_text('{"username": "ancien"}', encoding="utf-8")

        bridge.set_account("lycee-hugo")
        assert bridge.load_tokens() is None


# ─────────────────────────────────────────────────────────────────────────────
# Protocole
# ─────────────────────────────────────────────────────────────────────────────

def test_le_compte_est_fixe_avant_l_action(bridge, capsys, monkeypatch):
    """`main()` doit choisir le compte AVANT de dispatcher : une action qui
    lirait les jetons avant ce choix les lirait dans le mauvais fichier."""
    vus = {}

    class _Entree(object):
        def read(self):
            return json.dumps({"action": "fetch", "account": "lycee-hugo"})

    monkeypatch.setattr("sys.stdin", _Entree())
    monkeypatch.setitem(bridge.ACTIONS, "fetch",
                        lambda payload: vus.setdefault("token_file", bridge.TOKEN_FILE) or {})
    bridge.main()

    assert json.loads(capsys.readouterr().out)["ok"] is True
    assert vus["token_file"].endswith("tokens-lycee-hugo.json")


# ─────────────────────────────────────────────────────────────────────────────
# Contrat de nommage entre Node et Python
# ─────────────────────────────────────────────────────────────────────────────

def test_la_validation_python_accepte_ce_que_node_produit(bridge):
    """Node normalise, Python valide. Si les deux règles divergent, un compte
    parfaitement légitime côté config.js serait refusé ici et rabattu sur
    « default » — écrivant les jetons d'un établissement dans le fichier d'un
    autre. Le test lit la vraie borne de longueur dans lib/accounts.js plutôt
    que de la recopier."""
    racine = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    source = io.open(os.path.join(racine, "lib", "accounts.js"), encoding="utf-8").read()

    borne = re.search(r"\.slice\(0,\s*(\d+)\)", source)
    assert borne, "borne de longueur introuvable dans lib/accounts.js"
    longueur_max = int(borne.group(1))

    motif_node = re.search(r"\^\[a-z0-9-\]\{1,(\d+)\}\$", source)
    assert motif_node, "motif de validation introuvable dans lib/accounts.js"

    borne_python = re.search(r"\{1,(\d+)\}", bridge._ACCOUNT_RE.pattern)
    assert borne_python, "borne de longueur introuvable dans _ACCOUNT_RE"

    # Trois bornes, une seule valeur admissible : la troncature de Node, sa
    # propre validation, et celle du pont.
    assert longueur_max == int(motif_node.group(1)) == int(borne_python.group(1)), (
        "bornes divergentes — troncature Node: %d, validation Node: %s, pont: %s"
        % (longueur_max, motif_node.group(1), borne_python.group(1)))

    # Une clé de longueur maximale doit passer de bout en bout.
    limite = "a" * longueur_max
    assert bridge.set_account(limite) == limite
