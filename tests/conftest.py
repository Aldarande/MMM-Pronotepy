# -*- coding: utf-8 -*-
# MMM-Pronotepy — module MagicMirror² pour Pronote
# Copyright (C) 2024-2026 Aldarande
# Licensed under the MIT License. See LICENSE for details.
"""
Doubles partagés par les tests du pont Python.

`pronote_bridge` importe pronotepy dès le chargement du module et, en cas
d'ImportError, écrit une réponse JSON puis appelle ``sys.exit(0)`` : il est
donc impossible de l'importer dans une CI qui n'aurait pas pronotepy — et
installer pronotepy pour tester des fonctions pures ferait sortir du réseau
une suite censée n'en avoir aucun besoin.

On injecte donc un faux paquet `pronotepy` dans ``sys.modules`` AVANT le
premier import du pont. Il porte exactement ce que le pont y cherche : les
classes clientes, la hiérarchie d'exceptions, et les deux points d'ancrage des
correctifs de pronote_compat (``clients.ClientBase`` et
``pronoteAPI._Encryption``).

⚠ La hiérarchie d'exceptions ci-dessous est recopiée de pronotepy 2.15.7
(``pronotepy/exceptions.py``). `classify()` s'appuie sur l'ordre des
`isinstance` — QRCodeDecryptError hérite de CryptoError — donc une divergence
entre ce double et l'amont ferait passer les tests sur un mauvais modèle. À
revérifier à chaque montée du plancher de requirements.txt.
"""

import datetime as dt
import os
import sys
import types

import pytest

MODULE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if MODULE_DIR not in sys.path:
    sys.path.insert(0, MODULE_DIR)


# ─────────────────────────────────────────────────────────────────────────────
# Faux paquet pronotepy
# ─────────────────────────────────────────────────────────────────────────────

def _install_pronotepy_stub():
    if "pronotepy" in sys.modules:
        return

    exceptions = types.ModuleType("pronotepy.exceptions")

    class PronoteAPIError(Exception):
        pass

    class CryptoError(PronoteAPIError):
        pass

    class QRCodeDecryptError(CryptoError):
        pass

    class ExpiredObject(PronoteAPIError):
        pass

    class ChildNotFound(PronoteAPIError):
        pass

    for cls in (PronoteAPIError, CryptoError, QRCodeDecryptError,
                ExpiredObject, ChildNotFound):
        setattr(exceptions, cls.__name__, cls)

    clients = types.ModuleType("pronotepy.clients")

    class ClientBase(object):
        """Assez de surface pour que les correctifs aient où se poser."""

        def _login(self):
            return True

        def post(self, function_name, onglet=None, data=None):
            return {"function": function_name, "onglet": onglet}

    class Client(ClientBase):
        pass

    class ParentClient(Client):
        """Reproduit fidèlement le piège de pronotepy 2.15.7.

        `set_child()` remplace l'enfant courant mais NE met PAS `info` à
        jour : celui-ci reste l'identité du titulaire du compte, posée une
        fois pour toutes dans `_login`. Un double qui « corrigerait »
        gentiment ce comportement rendrait le test de `account_info`
        incapable de détecter la régression qu'il est censé garder.
        """

        children = []
        _selected_child = None

        def set_child(self, child):
            self._selected_child = child

    clients.ClientBase = ClientBase
    clients.Client = Client
    clients.ParentClient = ParentClient

    pronote_api = types.ModuleType("pronotepy.pronoteAPI")

    class _Encryption(object):
        def aes_decrypt(self, data):
            return data

    pronote_api._Encryption = _Encryption

    root = types.ModuleType("pronotepy")
    root.__path__ = []          # paquet : autorise `from pronotepy import ...`
    root.__version__ = "2.15.7-stub"
    root.Client = Client
    root.ParentClient = ParentClient
    root.clients = clients
    root.exceptions = exceptions
    root.pronoteAPI = pronote_api

    sys.modules["pronotepy"] = root
    sys.modules["pronotepy.clients"] = clients
    sys.modules["pronotepy.exceptions"] = exceptions
    sys.modules["pronotepy.pronoteAPI"] = pronote_api


_install_pronotepy_stub()


# ─────────────────────────────────────────────────────────────────────────────
# Doubles du domaine Pronote
#
# pronotepy expose des objets, pas des dictionnaires : le pont lit
# `lesson.subject.name`, `hw.date`, `period.absences`… Ces doubles portent
# strictement les attributs consommés par le pont.
# ─────────────────────────────────────────────────────────────────────────────

class Nomme(object):
    """Matière, professeur… : tout ce qui n'a qu'un nom."""

    def __init__(self, name):
        self.name = name


class Lesson(object):
    def __init__(self, start, end, subject=None, teacher_names=None,
                 classrooms=None, canceled=False, detention=False, status=""):
        self.start = start
        self.end = end
        self.subject = Nomme(subject) if subject else None
        self.teacher_names = teacher_names or []
        self.classrooms = classrooms or []
        self.canceled = canceled
        self.detention = detention
        self.status = status


class Homework(object):
    def __init__(self, date, subject="", description="", done=False):
        self.date = date
        self.subject = Nomme(subject) if subject else None
        self.description = description
        self.done = done


class Grade(object):
    def __init__(self, date, subject="", grade="0", out_of="20",
                 average="10", coefficient="1", comment=""):
        self.date = date
        self.subject = Nomme(subject) if subject else None
        self.grade = grade
        self.out_of = out_of
        self.average = average
        self.coefficient = coefficient
        self.comment = comment


class Absence(object):
    def __init__(self, from_date, to_date=None, reasons=None,
                 justified=False, hours="", days=0):
        self.from_date = from_date
        self.to_date = to_date
        self.reasons = reasons or []
        self.justified = justified
        self.hours = hours
        self.days = days


class Delay(object):
    def __init__(self, date, minutes=0, justified=False, reasons=None):
        self.date = date
        self.minutes = minutes
        self.justified = justified
        self.reasons = reasons or []


class Punishment(object):
    def __init__(self, given, nature="", reasons=None):
        self.given = given
        self.nature = nature
        self.reasons = reasons or []


class Period(object):
    def __init__(self, start, end, name="", absences=None, delays=None,
                 punishments=None, grades=None):
        self.start = start
        self.end = end
        self.name = name
        self.absences = absences or []
        self.delays = delays or []
        self.punishments = punishments or []
        self.grades = grades or []

    def __repr__(self):
        return "<Period %s>" % (self.name or "%s→%s" % (self.start, self.end))


class FakeClient(object):
    """Client pronotepy réduit à ce que le pont interroge.

    `lessons()` reçoit une plage de dates et rend les cours qui y tombent :
    c'est le comportement dont dépend collect_timetable, qui demande une plage
    de 14 jours d'un seul appel.
    """

    def __init__(self, lessons=None, homeworks=None, periods=None,
                 current=None, info=None):
        self._lessons = lessons or []
        self._homeworks = homeworks or []
        self.periods = periods or []
        self._current = current
        self.info = info or Nomme("Élève Test")
        self.logged_in = True
        self.calls = {"lessons": [], "homework": []}

    @property
    def current_period(self):
        if self._current is None:
            raise RuntimeError("aucune période courante")
        return self._current

    def lessons(self, start, end=None):
        self.calls["lessons"].append((start, end))
        end = end or start
        return [l for l in self._lessons if start <= l.start.date() <= end]

    def homework(self, start, end=None):
        self.calls["homework"].append((start, end))
        end = end or start
        return [h for h in self._homeworks if start <= h.date <= end]


@pytest.fixture
def aujourdhui():
    """Date du jour, seule référence temporelle des tests.

    Le pont appelle `dt.date.today()` ; plutôt que de geler l'horloge — ce qui
    casserait les `isinstance` sur `dt.date` — les scénarios se construisent
    relativement à aujourd'hui.
    """
    return dt.date.today()


@pytest.fixture
def bridge():
    """Le module `pronote_bridge`, importé une fois le faux pronotepy en place."""
    import pronote_bridge
    return pronote_bridge
