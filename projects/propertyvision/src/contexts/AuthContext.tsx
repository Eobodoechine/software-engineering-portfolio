'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

// Mock User type (replacing Firebase User)
interface User {
  uid: string;
  email: string | null;
  displayName?: string | null;
}

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string, phone: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  loading: boolean;
}

interface UserProfile {
  uid: string;
  email: string;
  name: string;
  phone: string;
  createdAt: Date;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Always use mock user for local testing (Firebase disabled)
    setUser({ uid: 'local-test-user', email: 'test@local.dev' });
    setUserProfile({
      uid: 'local-test-user',
      email: 'test@local.dev',
      name: 'Local Test User',
      phone: '',
      createdAt: new Date()
    });
    setLoading(false);
  }, []);

  const login = async (email: string, password: string) => {
    // Mock login
    setUser({ uid: 'mock-user', email });
    setUserProfile({
      uid: 'mock-user',
      email,
      name: 'Mock User',
      phone: '',
      createdAt: new Date()
    });
  };

  const signup = async (email: string, password: string, name: string, phone: string) => {
    // Mock signup
    setUser({ uid: 'mock-user', email });
    setUserProfile({
      uid: 'mock-user',
      email,
      name,
      phone,
      createdAt: new Date()
    });
  };

  const loginWithGoogle = async () => {
    // Mock Google login
    setUser({ uid: 'mock-google-user', email: 'google@test.com' });
    setUserProfile({
      uid: 'mock-google-user',
      email: 'google@test.com',
      name: 'Google Test User',
      phone: '',
      createdAt: new Date()
    });
  };

  const logout = async () => {
    setUser(null);
    setUserProfile(null);
  };

  const value = {
    user,
    userProfile,
    login,
    signup,
    loginWithGoogle,
    logout,
    loading
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
