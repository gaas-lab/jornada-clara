import { useEffect, useMemo, useState } from 'react';
import {
  COMPANY_TIME_ZONE,
  DAILY_WORK_MINUTES,
  PUNCH_SEQUENCE,
  createDayRecord,
  estimatedEnd,
  formatClock,
  formatMinutes,
  localDateKey,
  nextPunch,
  workedMinutes,
} from '../features/attendance/domain/attendance.js';
import {
  readAttendanceDay,
  registerAttendancePunch,
} from '../features/attendance/services/supabaseAttendanceStore.js';
import { isSupabaseConfigured, supabase } from '../shared/lib/supabase.js';
import './app.css';

const WEEKDAY_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: COMPANY_TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const WEEKEND_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: COMPANY_TIME_ZONE,
  weekday: 'short',
});

const ROLE_LABELS = {
  employee: 'Funcionário',
  manager: 'Gestor',
  admin_master: 'Admin Master',
};

function isWeekend(date) {
  return ['Sat', 'Sun'].includes(WEEKEND_FORMAT.format(date));
}

function formatSignedMinutes(minutes) {
  const sign = minutes > 0 ? '+' : minutes < 0 ? '−' : '';
  return `${sign}${formatMinutes(Math.abs(minutes))}`;
}

function LoginScreen({ email, password, busy, message, onEmail, onPassword, onSubmit }) {
  return (
    <main className="app-shell auth-shell">
      <header className="app-header">
        <div>
          <p className="app-kicker">Controle interno de jornada</p>
          <h1>Jornada Clara</h1>
        </div>
        <div className="local-mode">Supabase</div>
      </header>

      <section className="auth-card" aria-labelledby="login-title">
        <p className="section-label">Acesso da equipe</p>
        <h2 id="login-title">Entrar na sua conta</h2>
        <p className="auth-description">Use o e-mail e a senha cadastrados para sua conta da empresa.</p>
        {message && <p className="feedback feedback--error" role="alert">{message}</p>}
        <form className="auth-form" onSubmit={onSubmit}>
          <label htmlFor="login-email">E-mail</label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => onEmail(event.target.value)}
          />
          <label htmlFor="login-password">Senha</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => onPassword(event.target.value)}
          />
          <button className="punch-button" type="submit" disabled={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <p className="auth-footnote">O cadastro de usuários é feito pela administração da empresa.</p>
      </section>

      <footer className="app-footer">
        <span>Uma empresa · jornada flexível · segunda a sexta</span>
        <span>Sem localização no primeiro momento</span>
      </footer>
    </main>
  );
}

function SetupMessage({ title, children }) {
  return (
    <main className="app-shell auth-shell">
      <header className="app-header">
        <div>
          <p className="app-kicker">Controle interno de jornada</p>
          <h1>Jornada Clara</h1>
        </div>
      </header>
      <section className="auth-card">
        <p className="section-label">Configuração</p>
        <h2>{title}</h2>
        <p className="auth-description">{children}</p>
      </section>
    </main>
  );
}

export default function App() {
  const [now, setNow] = useState(() => new Date());
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [days, setDays] = useState({});
  const [authLoading, setAuthLoading] = useState(isSupabaseConfigured);
  const [profileLoading, setProfileLoading] = useState(false);
  const [dayLoading, setDayLoading] = useState(false);
  const [punchLoading, setPunchLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [attendanceError, setAttendanceError] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return undefined;
    }

    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setAuthLoading(false);
      if (!nextSession) {
        setProfile(null);
        setDays({});
        setProfileError('');
        setAttendanceError('');
      }
    });

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setMessage(error.message);
        setMessageType('error');
      }
      setSession(data.session);
      setAuthLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !session?.user?.id) {
      setProfile(null);
      setProfileLoading(false);
      return undefined;
    }

    let active = true;
    setProfileLoading(true);
    setProfileError('');

    supabase
      .from('profiles')
      .select('id, full_name, role, is_active')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setProfileError(error.message);
          setProfile(null);
        } else if (!data) {
          setProfileError('Sua conta ainda não tem um perfil criado. Peça ajuda ao Admin Master.');
          setProfile(null);
        } else if (!data.is_active) {
          setProfileError('Este perfil está desativado. Peça ajuda ao Admin Master.');
          setProfile(data);
        } else {
          setProfile(data);
        }
        setProfileLoading(false);
      });

    return () => { active = false; };
  }, [session?.user?.id]);

  const todayKey = localDateKey(now);

  useEffect(() => {
    if (!profile?.id || !profile.is_active) {
      setDayLoading(false);
      return undefined;
    }

    let active = true;
    setDayLoading(true);
    setAttendanceError('');
    readAttendanceDay(profile.id, todayKey)
      .then((record) => {
        if (!active) return;
        setDays((current) => ({ ...current, [todayKey]: record }));
      })
      .catch((error) => {
        if (!active) return;
        setAttendanceError(error.message || 'Não foi possível carregar as marcações.');
      })
      .finally(() => {
        if (active) setDayLoading(false);
      });

    return () => { active = false; };
  }, [profile?.id, profile?.is_active, todayKey]);

  const todayRecord = days[todayKey] ?? createDayRecord();
  const next = nextPunch(todayRecord);
  const worked = workedMinutes(todayRecord, now);
  const estimated = estimatedEnd(todayRecord, now);
  const weekend = isWeekend(now);
  const completed = todayRecord.punches.length === PUNCH_SEQUENCE.length;
  const progress = Math.min(100, Math.round((worked / DAILY_WORK_MINUTES) * 100));
  const status = useMemo(() => {
    if (weekend) return 'Dia sem expediente';
    if (completed) return 'Jornada encerrada';
    if (todayRecord.punches.length === 2) return 'Intervalo em andamento';
    if (todayRecord.punches.length === 0) return 'Aguardando sua entrada';
    return 'Expediente em andamento';
  }, [completed, todayRecord.punches.length, weekend]);

  async function handleSignIn(event) {
    event.preventDefault();
    if (!supabase) return;
    setAuthLoading(true);
    setMessage('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setAuthLoading(false);
    if (error) {
      setMessage(error.message);
      setMessageType('error');
    }
  }

  async function handleSignOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
      setMessage(error.message);
      setMessageType('error');
    }
  }

  async function registerNextPunch() {
    if (!next || !profile?.id || punchLoading) return;
    setPunchLoading(true);
    setMessage('');

    try {
      await registerAttendancePunch();
      const updatedRecord = await readAttendanceDay(profile.id, todayKey);
      setDays((current) => ({ ...current, [todayKey]: updatedRecord }));
      const recordedPunch = updatedRecord.punches.at(-1);
      const label = PUNCH_SEQUENCE[updatedRecord.punches.length - 1]?.label ?? 'Marcação';
      setNow(new Date());
      setMessage(`${label} registrada às ${formatClock(recordedPunch?.at)}.`);
      setMessageType('success');
    } catch (error) {
      setMessage(error.message || 'Não foi possível registrar este horário.');
      setMessageType('error');
    } finally {
      setPunchLoading(false);
    }
  }

  if (!isSupabaseConfigured) {
    return (
      <SetupMessage title="Supabase não configurado">
        Confira a URL e a chave publicável do projeto no arquivo local <code>.env.local</code> e reinicie o servidor do app.
      </SetupMessage>
    );
  }

  if (authLoading) {
    return <SetupMessage title="Conectando…">Verificando sua sessão do Supabase.</SetupMessage>;
  }

  if (!session) {
    return (
      <LoginScreen
        email={email}
        password={password}
        busy={authLoading}
        message={message}
        onEmail={setEmail}
        onPassword={setPassword}
        onSubmit={handleSignIn}
      />
    );
  }

  if (profileLoading) {
    return <SetupMessage title="Carregando seu perfil…">Buscando suas permissões de acesso.</SetupMessage>;
  }

  if (profileError || !profile || !profile.is_active) {
    return (
      <main className="app-shell auth-shell">
        <header className="app-header">
          <div>
            <p className="app-kicker">Controle interno de jornada</p>
            <h1>Jornada Clara</h1>
          </div>
          <button className="sign-out-button" type="button" onClick={handleSignOut}>Sair</button>
        </header>
        <section className="auth-card">
          <p className="section-label">Perfil indisponível</p>
          <h2>Não foi possível carregar seu acesso</h2>
          <p className="auth-description">{profileError || 'Peça ajuda ao Admin Master da empresa.'}</p>
        </section>
      </main>
    );
  }

  const completedPunches = new Map(todayRecord.punches.map((punch) => [punch.kind, punch.at]));
  const displayName = profile.full_name || session.user.email;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-kicker">Controle interno de jornada</p>
          <h1>Jornada Clara</h1>
        </div>
        <div className="signed-in-user">
          <div>
            <strong>{displayName}</strong>
            <span>{ROLE_LABELS[profile.role] ?? profile.role}</span>
          </div>
          <button className="sign-out-button" type="button" onClick={handleSignOut}>Sair</button>
        </div>
      </header>

      <section className="demo-notice" aria-label="Aviso sobre armazenamento">
        <strong>Conectado ao Supabase</strong>
        <span>As marcações são salvas no banco da empresa e validadas pelo servidor.</span>
      </section>

      <section className="today-layout" aria-label="Jornada de hoje">
        <div className="today-main">
          <div className="date-row">
            <div>
              <p className="section-label">Hoje</p>
              <h2>{WEEKDAY_FORMAT.format(now)}</h2>
            </div>
            <time className="live-clock" dateTime={now.toISOString()}>
              {formatClock(now)}
            </time>
          </div>

          <div className="status-row">
            <span className={`status-dot${completed ? ' status-dot--done' : ''}`} aria-hidden="true" />
            <span>{dayLoading ? 'Carregando marcações…' : attendanceError ? 'Falha ao carregar o dia' : status}</span>
          </div>

          <div className="work-summary">
            <div className="work-summary__value">{formatMinutes(worked)}</div>
            <div className="work-summary__caption">trabalhadas de {formatMinutes(DAILY_WORK_MINUTES)}</div>
            <div className="progress-track" aria-label={`${progress}% da jornada cumprida`}>
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="estimate-row">
            <span>Previsão de saída</span>
            <strong>{completed ? 'Jornada finalizada' : estimated ? formatClock(estimated) : '—'}</strong>
          </div>

          {attendanceError && (
            <p className="feedback feedback--error" role="alert">
              {attendanceError}. Atualize a página ou tente novamente mais tarde.
            </p>
          )}
          {message && (
            <p className={`feedback feedback--${messageType}`} role="status">
              {message}
            </p>
          )}

          <button
            className="punch-button"
            type="button"
            onClick={registerNextPunch}
            disabled={!next || weekend || dayLoading || Boolean(attendanceError) || punchLoading}
          >
            {punchLoading
              ? 'Registrando…'
              : weekend
                ? 'Sem expediente hoje'
                : next
                  ? `Registrar ${next.label.toLowerCase()}`
                  : 'Jornada concluída'}
          </button>
          <p className="sequence-hint">As marcações seguem a ordem definida pela empresa.</p>
        </div>

        <aside className="today-sidebar">
          <section className="panel" aria-labelledby="marks-title">
            <div className="panel-heading">
              <div>
                <p className="section-label">Registro do dia</p>
                <h3 id="marks-title">Marcações</h3>
              </div>
              <span className="mark-count">{todayRecord.punches.length}/4</span>
            </div>
            <ol className="mark-list">
              {PUNCH_SEQUENCE.map((item, index) => {
                const at = completedPunches.get(item.kind);
                const pending = !at && index === todayRecord.punches.length && !weekend;
                return (
                  <li className={`mark-item${at ? ' mark-item--complete' : ''}${pending ? ' mark-item--next' : ''}`} key={item.kind}>
                    <span className="mark-item__number">{at ? '✓' : index + 1}</span>
                    <span className="mark-item__label">{item.label}</span>
                    <time className="mark-item__time" dateTime={at || undefined}>{formatClock(at)}</time>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="panel balance-panel" aria-labelledby="balance-title">
            <p className="section-label">Resumo diário</p>
            <h3 id="balance-title">Saldo de hoje</h3>
            <div className="balance-value">
              {completed ? formatSignedMinutes(worked - DAILY_WORK_MINUTES) : 'Em andamento'}
            </div>
            <p>{completed ? 'Comparado à jornada diária de 8h48min.' : 'O saldo é calculado ao finalizar as quatro marcações.'}</p>
          </section>
        </aside>
      </section>

      <footer className="app-footer">
        <span>Uma empresa · jornada flexível · segunda a sexta</span>
        <span>Sem localização no primeiro momento</span>
      </footer>
    </main>
  );
}
