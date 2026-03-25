import React, { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

interface UserInfoConfig {
    sapId: '',//8
    ystId: '',//6
    userName: '',
    originOrgId: '',
    orgName: '',
    ystRefreshToken: '',
    ystCode: '',
    ystAccessToken: '',
}

const UserInfoPanel: React.FC = () => {
    const [user, setUser] = useState<UserInfoConfig>({} as UserInfoConfig);
    const [initFlag, setInitFlag] = useState(false)//初始化标志，用于判断是否已经初始化
    useEffect(() => {
        window.electron.onNotifyMsg(() => {
            initUser()
        })
        initUser()
    }, []);
    const initUser = () => {
        window.api.models.getUserInfo().then(user => {
            const userInfo = user as UserInfoConfig || {}
            if (userInfo.sapId) {
                fetch(`https://archguardservice.paas.${import.meta.env.VITE_LOGIN_PT}.cn/cowork/login-info`, {
                    method: 'GET',
                    headers: {
                        ystCode: userInfo.ystCode,
                        ystRefreshToken: userInfo.ystRefreshToken || '',
                    }
                }).then(async res => {
                    const result = await res.json()
                    if (result.returnCode === 'SUC0000') {
                        const resBody = result.body
                        setUser({
                            sapId: resBody.sapId,//8
                            ystId: resBody.ystId,//6
                            userName: resBody.userName,
                            originOrgId: resBody.originOrgId,
                            orgName: resBody.orgName,
                            ystRefreshToken: result.ystrefreshtoken,
                            ystAccessToken: result.ystAccessToken
                        } as UserInfoConfig)
                    }
                }).catch(err => {
                    console.log(err)
                }).finally(() => {
                    setInitFlag(true)
                })
            } else {
                setInitFlag(true)
            }
        });
    };

    const handleLogin = async () => {
        window.electron.openLoginWindow()
    };

    const handleLogout = async () => {
        const uuIfo: UserInfoConfig = {
            sapId: '',//8
            ystId: '',//6
            userName: '',
            originOrgId: '',
            orgName: '',
            ystRefreshToken: '',
            ystCode: '',
            ystAccessToken: '',
        }
        window.api.models.upsertUserInfo(uuIfo).then(() => {
            setUser(uuIfo)
        });
    };

    const getInitials = (name: string) => {
        if (!name) return ''
        return name.split(' ').map(word => word[0]).join('').toUpperCase();
    };

    if (!initFlag) {
        return null
    }
    return (
        <Card className="w-full">
            <CardContent>
                {user.sapId ? (
                    // 登录状态
                    <div className="space-y-4">
                        <div className="flex items-center mt-2">
                            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
                                <span className="text-blue-600 font-semibold text-lg">
                                    {getInitials(user.userName)}
                                </span>
                            </div>
                            <div className="flex-1 min-w-0 ml-2">
                                <h3 className="text-lg font-semibold truncate">{user.userName}</h3>
                                <p className="text-sm text-gray-600 truncate">{user.orgName}</p >
                            </div>
                        </div>

                        <Button variant="outline" onClick={handleLogout} className="w-40">
                            退出登录
                        </Button>
                    </div>
                ) : (
                    // 未登录状态
                    <div className="text-center space-y-4">
                        <div className="flex justify-center">
                            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
                                <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                </svg>
                            </div>
                        </div>
                        <div>
                            <h3 className="text-lg font-medium text-gray-900">未登录</h3>
                            <p className="text-sm text-gray-500">请登录以查看个人信息</p >
                        </div>
                        <Button onClick={handleLogin} className="w-full">
                            立即登录
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export { UserInfoPanel };

