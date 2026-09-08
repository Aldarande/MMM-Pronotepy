# -*- coding: utf-8 -*-
# MMM-Pronotepy — module MagicMirror² pour Pronote
# Copyright (C) 2024-2026 Aldarande
# Licensed under the MIT License. See LICENSE for details.
"""
Tests des couches de compatibilité de `pronote_compat.py`.

Chaque correctif est éprouvé séparément, sur un échantillon figé, contre le
faux pronotepy de conftest.py.

Pourquoi figer un échantillon plutôt que se fier à une connexion réelle : ces
correctifs se déclenchent sur des cas qu'on ne provoque pas à la demande — un
serveur PRONOTE resté en protocole ancien, un compte parent privé de l'onglet
Notes. Un échantillon écrit une fois rejoue les deux à volonté ; sans lui, la
seule preuve qu'ils marchent encore serait qu'un miroir tombe en panne.

L'échantillon de challenge vient d'une capture réelle sur une instance PRONOTE
2026.2.5.7 (issue pronotepy #348), réduite à ce qui compte : sa taille — un
bloc AES — et le fait que sa forme hexadécimale doublée survive à
``_enleverAlea()``.
"""

import logging

import pytest

import pronote_compat


# Un bloc AES capturé à l'Identification. Seize octets : c'est cette taille,
# et elle seule, qui distingue le protocole 2026 de l'ancien.
CHALLENGE_2026 = bytes(range(16))


# ─────────────────────────────────────────────────────────────────────────────
# Correctif 1 — challenge d'authentification non chiffré
# ─────────────────────────────────────────────────────────────────────────────

def _enlever_alea(chaine):
    """Réimplémentation de `_enleverAlea` de pronotepy : un caractère sur deux.

    C'est le traitement que pronotepy applique au retour de `aes_decrypt`.
    Le correctif ne marche que si sa sortie y survit — d'où cette copie, qui
    rejoue l'étape aval sans dépendre de la vraie bibliothèque.
    """
    return "".join(chaine[i] for i in range(1, len(chaine), 2))


class TestChallengeBrut:
    def test_le_doublage_survit_au_retrait_de_l_alea(self):
        """Le cœur du correctif : après `_enleverAlea`, pronotepy doit
        retrouver exactement le challenge hexadécimal reçu."""
        rendu = pronote_compat._challenge_brut(CHALLENGE_2026).decode()
        assert _enlever_alea(rendu) == CHALLENGE_2026.hex().upper()

    def test_forme_attendue(self):
        assert pronote_compat._challenge_brut(b"\x00\x01").decode() == "00000011"

    def test_majuscules(self):
        """PRONOTE renvoie l'hexadécimal en majuscules ; le rechiffrement
        porte sur la chaîne exacte, la casse n'est pas cosmétique."""
        rendu = pronote_compat._challenge_brut(b"\xab\xcd").decode()
        assert rendu == "AABBCCDD"

    def test_bloc_vide(self):
        assert pronote_compat._challenge_brut(b"") == b""


class TestEstChallengeClair:
    """Le prédicat qui décide de détourner, ou non, un déchiffrement."""

    def setup_method(self):
        self.session = object()      # chiffrement de la communication
        self.login = object()        # chiffrement local à _login

    def test_bloc_unique_hors_session(self):
        assert pronote_compat._est_challenge_clair(
            self.login, self.session, CHALLENGE_2026) is True

    def test_chiffrement_de_session_jamais_detourne(self):
        """C'est lui qui déchiffre les réponses du serveur et la clé de session
        dans `after_auth` : le détourner casserait toute la communication."""
        assert pronote_compat._est_challenge_clair(
            self.session, self.session, CHALLENGE_2026) is False

    def test_plusieurs_blocs_laisses_au_chemin_historique(self):
        """Un serveur antérieur entrelace un aléa : le challenge dépasse
        toujours un bloc."""
        assert pronote_compat._est_challenge_clair(
            self.login, self.session, bytes(32)) is False

    def test_bloc_partiel(self):
        assert pronote_compat._est_challenge_clair(
            self.login, self.session, bytes(8)) is False

    def test_session_inconnue(self):
        """Sans référence de comparaison, on ne peut pas garantir qu'on ne
        détourne que le challenge : on s'abstient."""
        assert pronote_compat._est_challenge_clair(
            self.login, None, CHALLENGE_2026) is False


# ─────────────────────────────────────────────────────────────────────────────
# Correctif 2 — ré-authentification inutile sur onglet non accessible
# ─────────────────────────────────────────────────────────────────────────────

class TestOngletRefuse:
    def test_onglet_hors_droits(self):
        assert pronote_compat._onglet_refuse([1, 2, 3], 9) is True

    def test_onglet_autorise(self):
        assert pronote_compat._onglet_refuse([1, 2, 3], 2) is False

    def test_requete_sans_onglet(self):
        """Toutes les requêtes ne visent pas un onglet."""
        assert pronote_compat._onglet_refuse([1, 2, 3], None) is False

    @pytest.mark.parametrize("autorises", [None, [], ()])
    def test_liste_inconnue_laisse_passer(self, autorises):
        """Liste vide veut dire « on ne sait pas », pas « aucun droit » :
        bloquer ici priverait le miroir de données qu'il pouvait obtenir."""
        assert pronote_compat._onglet_refuse(autorises, 9) is False


# ─────────────────────────────────────────────────────────────────────────────
# Pose des correctifs
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def compat_neuf(monkeypatch):
    """`apply()` est idempotent par un drapeau global : on le remet à zéro
    pour que chaque test reparte d'un pronotepy non patché."""
    import pronotepy.clients as clients
    import pronotepy.pronoteAPI as api

    monkeypatch.setattr(pronote_compat, "_applied", False)
    monkeypatch.setattr(clients.ClientBase, "_login", clients.ClientBase._login)
    monkeypatch.setattr(clients.ClientBase, "post", clients.ClientBase.post)
    monkeypatch.setattr(api._Encryption, "aes_decrypt", api._Encryption.aes_decrypt)
    return pronote_compat


class TestApply:
    def test_idempotent(self, compat_neuf):
        import pronotepy.clients as clients
        compat_neuf.apply()
        pose = clients.ClientBase._login
        compat_neuf.apply()
        assert clients.ClientBase._login is pose

    def test_ne_leve_jamais_si_pronotepy_a_bouge(self, compat_neuf, monkeypatch, caplog):
        """Les correctifs s'appuient sur des internes de pronotepy. Si une
        version future les déplace, on veut une connexion qui échoue avec le
        message d'origine — pas un miroir qui refuse de démarrer."""
        def _explose():
            raise AttributeError("ClientBase._login a disparu")

        monkeypatch.setattr(compat_neuf, "_install", _explose)
        with caplog.at_level(logging.WARNING):
            compat_neuf.apply()          # ne doit pas lever

        assert "non installé" in caplog.text
        assert compat_neuf._applied is False

    def test_challenge_detourne_pendant_le_login_seulement(self, compat_neuf, monkeypatch):
        """Hors `_login`, `aes_decrypt` doit retrouver son comportement
        d'origine : un PIN faux doit continuer à lever QRCodeDecryptError,
        or le champ « login » d'un QR Code fait lui aussi un seul bloc."""
        import pronotepy.clients as clients
        import pronotepy.pronoteAPI as api

        chiffrement_origine = api._Encryption.aes_decrypt
        vus = {}

        class FauxClient(clients.ClientBase):
            def __init__(self):
                self.communication = type("Comm", (), {"encryption": api._Encryption()})()

        def _login_qui_dechiffre(self):
            chiffrement_login = api._Encryption()
            vus["challenge"] = chiffrement_login.aes_decrypt(CHALLENGE_2026)
            vus["session"] = self.communication.encryption.aes_decrypt(CHALLENGE_2026)
            return True

        monkeypatch.setattr(clients.ClientBase, "_login", _login_qui_dechiffre)
        compat_neuf.apply()

        client = FauxClient()
        assert clients.ClientBase._login(client) is True

        # Le challenge est détourné…
        assert vus["challenge"] == compat_neuf._challenge_brut(CHALLENGE_2026)
        # …mais pas le chiffrement de la communication.
        assert vus["session"] == CHALLENGE_2026
        # …et tout est rendu en sortie de _login.
        assert api._Encryption.aes_decrypt is chiffrement_origine

    def test_chiffrement_restaure_meme_si_le_login_echoue(self, compat_neuf, monkeypatch):
        """Le `finally` compte : sans lui, un login raté laisserait le
        détournement en place pour tout le reste de la session."""
        import pronotepy.clients as clients
        import pronotepy.pronoteAPI as api

        chiffrement_origine = api._Encryption.aes_decrypt

        def _login_qui_echoue(self):
            raise RuntimeError("Pronote a refusé")

        monkeypatch.setattr(clients.ClientBase, "_login", _login_qui_echoue)
        compat_neuf.apply()

        with pytest.raises(RuntimeError):
            clients.ClientBase._login(clients.ClientBase())

        assert api._Encryption.aes_decrypt is chiffrement_origine

    def test_onglet_refuse_sans_appel_reseau(self, compat_neuf, monkeypatch):
        """Le correctif doit court-circuiter `post` : chaque réessai coûterait
        une authentification, donc une rotation de jeton."""
        import pronotepy.clients as clients
        import pronotepy.exceptions as exc

        appels = []
        monkeypatch.setattr(clients.ClientBase, "post",
                            lambda self, fn, onglet=None, data=None: appels.append(fn))
        compat_neuf.apply()

        client = clients.ClientBase()
        client.communication = type("Comm", (), {"authorized_onglets": [1, 2]})()

        with pytest.raises(exc.PronoteAPIError):
            client.post("PageCahierDeTexte", onglet=88)
        assert appels == []

        client.post("PageEmploiDuTemps", onglet=2)
        assert appels == ["PageEmploiDuTemps"]

    def test_onglet_passe_si_les_droits_sont_inconnus(self, compat_neuf, monkeypatch):
        import pronotepy.clients as clients

        appels = []
        monkeypatch.setattr(clients.ClientBase, "post",
                            lambda self, fn, onglet=None, data=None: appels.append(fn))
        compat_neuf.apply()

        client = clients.ClientBase()      # pas de `communication`
        client.post("PageNotes", onglet=88)
        assert appels == ["PageNotes"]
