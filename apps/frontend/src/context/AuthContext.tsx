import React, { createContext, useContext, useState, useEffect } from 'react';

export interface User {
  id: string;
  email: string;
  role: 'marketer' | 'client';
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
  apiUrl: string;
  fetchWithAuth: (endpoint: string, options?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Read backend base URL (API port defaults to 3000)
  const apiUrl = (import.meta.env.VITE_API_URL as string) || 'http://localhost:3000';

  useEffect(() => {
    const storedToken = localStorage.getItem('tf_token');
    const storedUser = localStorage.getItem('tf_user');

    if (storedToken && storedUser) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      } catch (e) {
        localStorage.removeItem('tf_token');
        localStorage.removeItem('tf_user');
      }
    }
    setLoading(false);
  }, []);

  const login = async (email: string, password: String) => {
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!res.ok) {
      let errData;
      try {
        errData = await res.json();
      } catch (e) {
        throw new Error('Login failed. Please check server connection.');
      }
      throw new Error(errData.message || 'Invalid email or password.');
    }

    const data = await res.json();
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('tf_token', data.token);
    localStorage.setItem('tf_user', JSON.stringify(data.user));
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('tf_token');
    localStorage.removeItem('tf_user');
  };

  const fetchWithAuth = async (endpoint: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const targetUrl = endpoint.startsWith('http') ? endpoint : `${apiUrl}${endpoint}`;
    const res = await fetch(targetUrl, {
      ...options,
      headers
    });

    if (res.status === 401 && token) {
      // Token is likely invalid/expired, log out the user
      logout();
    }

    return res;
  };

  const value: AuthContextType = {
    user,
    token,
    login,
    logout,
    isAuthenticated: !!token,
    apiUrl,
    fetchWithAuth
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
